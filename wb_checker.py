# -*- coding: utf-8 -*-
"""
WB+Ozon Checker — единая программа проверки карточек Wildberries и Ozon
против реестров (ФСА, SWIS, Belgiss, EAEU).

Версия: 2026-06-05-v27-unified-ozon

Архитектура:
  • Один Python-файл с встроенным современным интерфейсом на pywebview
    (нативное окно с HTML/CSS/JS внутри).
  • Backend = существующие движки main_v39.py, main_brand.py, ozon_parser.py,
    а также wb_enhanced.py и fsa_enhanced.py (улучшения).
  • 6 режимов: query_full, query_stage1, query_stage2, brand, ozon, unified.
  • 5 экранов в UI: 🚀 Запуск, 📋 Очередь, 📊 Результаты, ⚙️ Настройки, 📜 Логи.
  • Bridge API между JS и Python через webview.api.*.
  • Поддержка слияния результатов WB + Ozon в unified-режиме.

Запуск:
    python wb_checker.py

Зависимости:
    pip install pywebview openpyxl aiohttp curl_cffi playwright beautifulsoup4 lxml
    python -m playwright install chromium

main_v39.py, main_brand.py и ozon_parser.py должны лежать рядом с wb_checker.py.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import platform
import queue
import re
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# pywebview import — обязательная зависимость
# ---------------------------------------------------------------------------
try:
    import webview  # type: ignore
except ImportError:
    print(
        "Не установлен pywebview. Установите: pip install pywebview",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------
APP_VERSION = "2026-06-06-v27.6-playwright"
APP_DIR = Path(__file__).resolve().parent
# pywebview на Windows часто запускается через pythonw.exe (без консоли) — это ломает stdout pipe в дочерних
# процессах. Сила принуждаем использовать python.exe (с консолью) для subprocess.
def _resolve_python() -> str:
    exe = sys.executable or "python3"
    if os.name == "nt" and exe.lower().endswith("pythonw.exe"):
        alt = exe[:-len("pythonw.exe")] + "python.exe"
        if Path(alt).exists():
            return alt
    return exe

PYTHON = _resolve_python()
SETTINGS_PATH = APP_DIR / "wb_checker_settings.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
log = logging.getLogger("wb_checker")


def _pick_engine_v39() -> Path:
    """Возвращает путь к движку WB query mode (берёт первый найденный файл)."""
    for name in ("main_v39.py", "main_v39-2.py", "main_v39_reporting.py"):
        p = APP_DIR / name
        if p.exists():
            return p
    return APP_DIR / "main_v39.py"


ENGINE_V39 = _pick_engine_v39()
ENGINE_BRAND = APP_DIR / "main_brand.py"
ENGINE_OZON = APP_DIR / "ozon_parser.py"
ENGINE_WB_ENHANCED = APP_DIR / "wb_enhanced.py"
ENGINE_FSA_ENHANCED = APP_DIR / "fsa_enhanced.py"


# ---------------------------------------------------------------------------
# Настройки
# ---------------------------------------------------------------------------

def load_settings() -> dict:
    """Загружает настройки из JSON-файла. Возвращает пустой словарь при ошибке."""
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            log.warning("Ошибка загрузки настроек: %s", exc)
    return {}


def save_settings(data: dict) -> None:
    """Сохраняет настройки в JSON-файл."""
    try:
        SETTINGS_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        log.error("Ошибка сохранения настроек: %s", exc)


# ---------------------------------------------------------------------------
# Модели данных
# ---------------------------------------------------------------------------

@dataclass
class RunSpec:
    """Единая модель параметров запуска для всех режимов."""

    mode: str = "query_full"
    """Режим: query_full | query_stage1 | query_stage2 | brand | ozon | unified"""

    query: str = ""
    """Поисковый запрос (для query_* и ozon/unified)."""

    brand: str = ""
    """Название бренда (для brand-режима)."""

    brand_match: str = "exact"
    """Тип совпадения бренда: exact | contains | any."""

    limit: int = 5000
    """Лимит карточек."""

    workers: int = 4
    """Количество параллельных воркеров/браузеров."""

    expiry_warning_days: int = 30
    """Порог (в днях) для метки «Скоро истекает»."""

    make_report_xlsx: bool = True
    """Создавать листы Сводка/Подробности в XLSX."""

    headless: bool = True
    """Запускать браузер в скрытом режиме."""

    strict_brand: str = ""
    """Строгий фильтр по бренду (для Stage 2)."""

    strict_brand_match: str = "any"
    """Тип строгого совпадения: any | exact | contains."""

    output: str = ""
    """Путь к итоговому XLSX (пусто = авто)."""

    output_links_csv: str = ""
    """CSV со ссылками (для Stage 1 → Stage 2)."""

    input_links_csv: str = ""
    """Входной CSV ссылок (для Stage 2)."""

    use_wb_enhanced: bool = False
    """Использовать wb_enhanced.py для улучшенного seller_name и плашки «Оригинал»."""

    use_fsa_enhanced: bool = False
    """Использовать fsa_enhanced.py для расширенных полей ФСА."""

    # Ozon-специфичные поля
    ozon_delay_min_ms: int = 200
    """Минимальная задержка между запросами Ozon (мс)."""

    ozon_delay_max_ms: int = 500
    """Максимальная задержка между запросами Ozon (мс)."""

    unified_report: bool = True
    """В unified-режиме: объединять WB и Ozon в один XLSX."""

    def wb_args(self) -> List[str]:
        """Формирует CLI-аргументы для WB-движка (query или brand)."""
        if self.mode == "brand":
            out = self.output or "brand_result.xlsx"
            return [
                PYTHON, str(ENGINE_BRAND),
                "--brand", self.brand,
                "--limit", str(self.limit),
                "--brand-match", self.brand_match,
                "--workers", str(self.workers),
                "--expiry-warning-days", str(self.expiry_warning_days),
                "--make-report-xlsx", "true" if self.make_report_xlsx else "false",
                "--output", out,
            ]
        engine = str(ENGINE_V39)
        if self.mode == "query_stage1":
            out = self.output or "links.xlsx"
            return [
                PYTHON, engine,
                "--query", self.query,
                "--limit", str(self.limit),
                "--link-only", "true",
                "--link-mode", "http_only",
                "--http-link-workers", str(self.workers * 10),
                "--output", out,
                "--output-links-csv", self.output_links_csv or "registry_links.csv",
            ]
        if self.mode == "query_stage2":
            out = self.output or "result.xlsx"
            args = [
                PYTHON, engine,
                "--input-links-csv", self.input_links_csv or "registry_links.csv",
                "--limit", str(self.limit),
                "--registry-headless", "true" if self.headless else "false",
                "--registry-browser-workers", str(self.workers),
                "--output", out,
                "--expiry-warning-days", str(self.expiry_warning_days),
                "--make-report-xlsx", "true" if self.make_report_xlsx else "false",
            ]
            if self.strict_brand and self.strict_brand_match != "any":
                args += ["--brand", self.strict_brand, "--brand-match", self.strict_brand_match]
            return args
        # query_full / unified (WB-часть)
        out = self.output or ("wb_result.xlsx" if self.mode == "unified" else "result.xlsx")
        return [
            PYTHON, engine,
            "--query", self.query,
            "--limit", str(self.limit),
            "--registry-headless", "true" if self.headless else "false",
            "--registry-browser-workers", str(self.workers),
            "--output", out,
            "--expiry-warning-days", str(self.expiry_warning_days),
            "--make-report-xlsx", "true" if self.make_report_xlsx else "false",
        ]

    def ozon_args(self) -> List[str]:
        """Формирует CLI-аргументы для движка Ozon."""
        out = self.output or ("ozon_result.xlsx" if self.mode != "unified" else "ozon_result.xlsx")
        args = [
            PYTHON, str(ENGINE_OZON),
            "--query", self.query,
            "--limit", str(self.limit),
            "--workers", str(self.workers),
            "--headless", "true" if self.headless else "false",
            "--output", out,
            "--expiry-warning-days", str(self.expiry_warning_days),
            "--make-report-xlsx", "true" if self.make_report_xlsx else "false",
            "--delay-min-ms", str(self.ozon_delay_min_ms),
            "--delay-max-ms", str(self.ozon_delay_max_ms),
        ]
        return args


@dataclass
class AppState:
    """Live-состояние прогона. Читается фронтом через polling."""

    running: bool = False
    mode: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0
    progress_done: int = 0
    progress_total: int = 0
    progress_pct: float = 0.0
    progress_stage: str = ""
    log_lines: List[str] = field(default_factory=list)
    output_path: str = ""
    ozon_output_path: str = ""
    log_path: str = ""
    metrics: Dict[str, Any] = field(default_factory=dict)
    last_cmd: str = ""
    error: str = ""
    stage_label: str = ""

    # Временные ряды для графика активности (последние 60 точек, каждая = 1 сек)
    activity_series: List[int] = field(default_factory=list)
    _last_activity_ts: float = field(default=0.0, repr=False)
    _activity_counter: int = field(default=0, repr=False)

    def tick_activity(self) -> None:
        """Увеличивает счётчик активности — вызывается на каждую обработанную строку."""
        now = time.time()
        self._activity_counter += 1
        if now - self._last_activity_ts >= 1.0:
            self.activity_series.append(self._activity_counter)
            if len(self.activity_series) > 60:
                self.activity_series = self.activity_series[-60:]
            self._activity_counter = 0
            self._last_activity_ts = now

    def to_dict(self) -> dict:
        """Сериализует состояние для передачи во фронтенд."""
        elapsed = 0.0
        if self.started_at:
            end = self.finished_at if (not self.running and self.finished_at) else time.time()
            elapsed = max(0.0, end - self.started_at)
        # Скорость: строк/мин за последние 30 точек активности
        speed = 0.0
        if len(self.activity_series) >= 2:
            window = self.activity_series[-30:]
            total_items = sum(window)
            speed = round(total_items * 60.0 / len(window), 1)
        return {
            "running": self.running,
            "mode": self.mode,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_sec": elapsed,
            "progress_done": self.progress_done,
            "progress_total": self.progress_total,
            "progress_pct": self.progress_pct,
            "progress_stage": self.progress_stage,
            "output_path": self.output_path,
            "ozon_output_path": self.ozon_output_path,
            "log_path": self.log_path,
            "metrics": self.metrics,
            "last_cmd": self.last_cmd,
            "error": self.error,
            "stage_label": self.stage_label,
            "log_total": len(self.log_lines),
            "activity_series": list(self.activity_series),
            "speed_per_min": speed,
        }


# ---------------------------------------------------------------------------
# Regex для парсинга stdout движков
# ---------------------------------------------------------------------------
# v27.9.x: однозначный маркер прогресса от движков (emit_progress). Парсится
# в первую очередь — это убирает скачки полосы из-за «повтор 2/5» и т.п.
PROGRESS_SENTINEL_RX = re.compile(
    r"@@PROGRESS@@\s+stage=(\S+)\s+done=(\d+)\s+total=(\d+)"
)
PROGRESS_RX = re.compile(r"(\d+)\s*/\s*(\d+)")
PROGRESS_PCT_RX = re.compile(r"(\d+(?:\.\d+)?)\s*%")
# Строки, где «X/Y» — это НЕ прогресс (счётчик повторов, попытки и т.п.).
PROGRESS_FALSE_RX = re.compile(r"повтор|retry|попытк|/мин|/час", re.IGNORECASE)
STATUS_RX = re.compile(
    r"\[(OK|ОШИБКА|ТАЙМАУТ|НЕТ ДОКУМЕНТОВ|НЕТ ССЫЛКИ НА РЕЕСТР|НЕСООТВЕТСТВИЕ|ССЫЛКА НА РЕЕСТР СОБРАНА)\]"
)
OUTPUT_RX = re.compile(r"(?:output|output_path|сохранено|saved)[:\s]+([^\s]+\.xlsx)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# EngineRunner — запуск движков и парсинг stdout
# ---------------------------------------------------------------------------

class EngineRunner:
    """
    Запускает subprocess-движки, читает stdout в фоновом потоке,
    парсит прогресс и метрики, обновляет AppState.
    """

    def __init__(self, state: AppState) -> None:
        self.state = state
        self.proc: Optional[subprocess.Popen] = None
        self.proc_ozon: Optional[subprocess.Popen] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_flag = threading.Event()

    def start(self, spec: RunSpec) -> None:
        """Запускает прогон по переданному RunSpec."""
        if self.state.running:
            raise RuntimeError("Прогон уже выполняется")
        self._reset_state(spec)
        self._stop_flag.clear()
        self._thread = threading.Thread(
            target=self._run, args=(spec,), daemon=True, name="runner"
        )
        self._thread.start()

    def stop(self) -> None:
        """Останавливает текущий прогон."""
        self._stop_flag.set()
        for proc in (self.proc, self.proc_ozon):
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:
                    pass

    def _reset_state(self, spec: RunSpec) -> None:
        s = self.state
        s.running = True
        s.mode = spec.mode
        s.started_at = time.time()
        s.finished_at = 0.0
        s.progress_done = 0
        s.progress_total = 0
        s.progress_pct = 0.0
        s.progress_stage = ""
        s.log_lines = []
        s.error = ""
        s.output_path = ""
        s.ozon_output_path = ""
        s.log_path = ""
        s.metrics = {"status": {}, "risk": {}, "registry": {}, "marketplace": {}}
        s.last_cmd = ""
        s.stage_label = ""
        s.activity_series = []
        s._last_activity_ts = 0.0
        s._activity_counter = 0

    def _run(self, spec: RunSpec) -> None:
        try:
            if spec.mode == "unified":
                self._run_unified(spec)
            elif spec.mode == "query_full":
                # Цепочка: Stage1 → Stage2
                s1 = RunSpec(**{**asdict(spec), "mode": "query_stage1",
                                "output_links_csv": "registry_links.csv",
                                "output": "links.xlsx"})
                rc = self._run_one(s1.wb_args(), "🔍 Этап 1 — сбор ссылок WB")
                if rc != 0 or self._stop_flag.is_set():
                    return
                s2 = RunSpec(**{**asdict(spec), "mode": "query_stage2",
                                "input_links_csv": "registry_links.csv"})
                self._run_one(s2.wb_args(), "📋 Этап 2 — парсинг реестров WB")
            elif spec.mode == "ozon":
                self._run_one(spec.ozon_args(), "🛒 Ozon — поиск и проверка")
            else:
                label_map = {
                    "query_stage1": "🔍 Этап 1 — сбор ссылок",
                    "query_stage2": "📋 Этап 2 — парсинг реестров",
                    "brand": "🏷️ Поиск по бренду WB",
                }
                self._run_one(spec.wb_args(), label_map.get(spec.mode, spec.mode))
        except Exception as exc:
            self.state.error = f"{type(exc).__name__}: {exc}"
            self.state.log_lines.append(f"[ОШИБКА] {self.state.error}")
            log.exception("Runner error")
        finally:
            self.state.running = False
            self.state.finished_at = time.time()
            # v27.9.x: явно «закрываем» прогресс, иначе после завершения полоса
            # остаётся на старом значении/этапе (особенно если движок нашёл 0
            # результатов и прогресс не двигался) — и кажется, что работа идёт.
            self.state.progress_stage = ""
            if not self.state.error:
                self.state.progress_pct = 100.0
                if self.state.progress_total:
                    self.state.progress_done = self.state.progress_total
            self._finalize_paths(spec)

    def _run_unified(self, spec: RunSpec) -> None:
        """Запускает WB и Ozon параллельно, затем мержит результаты."""
        self.state.stage_label = "🔄 Unified: WB + Ozon параллельно"
        wb_spec = RunSpec(**{**asdict(spec),
                             "mode": "query_full",
                             "output": str(APP_DIR / "wb_result.xlsx")})
        ozon_spec = RunSpec(**{**asdict(spec),
                               "mode": "ozon",
                               "output": str(APP_DIR / "ozon_result.xlsx")})

        wb_lines: List[str] = []
        ozon_lines: List[str] = []
        results: Dict[str, int] = {}

        def run_wb() -> None:
            rc = self._run_one_collect(wb_spec.wb_args(), "📦 WB — поиск + реестры", wb_lines)
            results["wb_rc"] = rc

        def run_ozon() -> None:
            rc = self._run_one_collect(ozon_spec.ozon_args(), "🛒 Ozon — поиск + реестры", ozon_lines)
            results["ozon_rc"] = rc

        t_wb = threading.Thread(target=run_wb, daemon=True, name="runner_wb")
        t_ozon = threading.Thread(target=run_ozon, daemon=True, name="runner_ozon")
        t_wb.start()
        t_ozon.start()
        t_wb.join()
        t_ozon.join()

        if self._stop_flag.is_set():
            return

        # Мерж результатов
        wb_xlsx = APP_DIR / "wb_result.xlsx"
        ozon_xlsx = APP_DIR / "ozon_result.xlsx"
        unified_xlsx = APP_DIR / (spec.output or "unified_result.xlsx")

        if wb_xlsx.exists() and ozon_xlsx.exists() and spec.unified_report:
            self.state.log_lines.append("\n━━━ 🔀 Объединение отчётов WB + Ozon ━━━")
            try:
                merge_xlsx(wb_xlsx, ozon_xlsx, unified_xlsx)
                self.state.output_path = str(unified_xlsx)
                self.state.log_lines.append(f"[OK] Unified отчёт: {unified_xlsx}")
            except Exception as exc:
                self.state.log_lines.append(f"[ОШИБКА мержа] {exc}")
                self.state.output_path = str(wb_xlsx) if wb_xlsx.exists() else str(ozon_xlsx)
        else:
            self.state.output_path = str(wb_xlsx) if wb_xlsx.exists() else ""
        self.state.ozon_output_path = str(ozon_xlsx) if ozon_xlsx.exists() else ""

    def _run_one(self, args: List[str], label: str) -> int:
        """Запускает один subprocess, читает stdout, возвращает код возврата."""
        self.state.stage_label = label
        self.state.log_lines.append(f"\n━━━ {label} ━━━")
        cmd_str = " ".join(f'"{a}"' if " " in str(a) else str(a) for a in args)
        self.state.last_cmd = cmd_str
        self.state.log_lines.append(f"[команда] {cmd_str}")
        try:
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONUTF8"] = "1"
            proc = subprocess.Popen(
                args,
                cwd=str(APP_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
            self.proc = proc
        except FileNotFoundError as exc:
            msg = f"[ОШИБКА ЗАПУСКА] Файл не найден: {exc}\n  args[0]={args[0] if args else '?'}\n  PYTHON={PYTHON}"
            self.state.log_lines.append(msg)
            self.state.error = msg
            return -1
        except Exception as exc:
            msg = f"[ОШИБКА ЗАПУСКА] {type(exc).__name__}: {exc}"
            self.state.log_lines.append(msg)
            self.state.error = msg
            return -1

        assert proc.stdout is not None
        for raw_line in proc.stdout:
            if self._stop_flag.is_set():
                break
            line = raw_line.rstrip("\n")
            self.state.log_lines.append(line)
            if len(self.state.log_lines) > 6000:
                self.state.log_lines = self.state.log_lines[-5000:]
            self._parse_line(line)

        proc.wait()
        rc = proc.returncode or 0
        self.state.log_lines.append(f"[завершено, код {rc}]")
        if rc != 0 and not self.state.error:
            self.state.error = f"Subprocess завершился с кодом {rc} (см. Логи)"
        return rc

    def _run_one_collect(self, args: List[str], label: str, lines_out: List[str]) -> int:
        """Версия _run_one для параллельного запуска — добавляет строки в lines_out."""
        self.state.log_lines.append(f"\n━━━ {label} ━━━")
        cmd_str = " ".join(f'"{a}"' if " " in str(a) else str(a) for a in args)
        self.state.log_lines.append(f"[команда] {cmd_str}")
        try:
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONUTF8"] = "1"
            proc = subprocess.Popen(
                args,
                cwd=str(APP_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
        except Exception as exc:
            msg = f"[ОШИБКА ЗАПУСКА {label}] {type(exc).__name__}: {exc}"
            self.state.log_lines.append(msg)
            self.state.error = msg
            return -1

        assert proc.stdout is not None
        for raw_line in proc.stdout:
            if self._stop_flag.is_set():
                break
            line = raw_line.rstrip("\n")
            lines_out.append(line)
            self.state.log_lines.append(f"  [{label[:2]}] {line}")
            if len(self.state.log_lines) > 6000:
                self.state.log_lines = self.state.log_lines[-5000:]
            self._parse_line(line)

        proc.wait()
        return proc.returncode or 0

    def _parse_line(self, line: str) -> None:
        """Парсит строку stdout: прогресс, метрики, пути к файлам."""
        # 1) Однозначный машиночитаемый маркер прогресса (приоритет).
        m = PROGRESS_SENTINEL_RX.search(line)
        if m:
            try:
                stage, d, t = m.group(1), int(m.group(2)), int(m.group(3))
                if 0 < t < 10_000_000:
                    self.state.progress_stage = stage
                    self.state.progress_done = d
                    self.state.progress_total = t
                    self.state.progress_pct = min(100.0, 100.0 * d / t)
                    self.state.tick_activity()
                    return
            except ValueError:
                pass
        # 2) Запасной разбор «X/Y» из обычного лога — но не из строк, где
        #    «X/Y» означает счётчик повторов/скорость (иначе полоса скачет).
        if not PROGRESS_FALSE_RX.search(line):
            m = PROGRESS_RX.search(line)
            if m:
                try:
                    d, t = int(m.group(1)), int(m.group(2))
                    if 0 < t < 10_000_000 and d <= t:
                        self.state.progress_done = d
                        self.state.progress_total = t
                        self.state.progress_pct = min(100.0, 100.0 * d / t)
                        self.state.tick_activity()
                        return
                except ValueError:
                    pass
        # Прогресс X%
        m = PROGRESS_PCT_RX.search(line)
        if m:
            try:
                self.state.progress_pct = min(100.0, float(m.group(1)))
            except ValueError:
                pass
        # Статус OK/ОШИБКА и т.д.
        m = STATUS_RX.search(line)
        if m:
            k = m.group(1)
            st = self.state.metrics.setdefault("status", {})
            st[k] = st.get(k, 0) + 1
            self.state.tick_activity()
        # v27.9.x: распределение по реестрам из строк прогресса (FSA=.., SWIS=..).
        # Это наполняет график «Реестры», который раньше оставался «нет данных».
        reg_hits = re.findall(r"\b(FSA|SWIS|BELGISS|BelGISS)\s*=\s*(\d+)", line)
        if reg_hits:
            reg = self.state.metrics.setdefault("registry", {})
            for _name, _val in reg_hits:
                _up = _name.upper()
                _key = "ФСА" if _up == "FSA" else ("SWIS" if _up == "SWIS" else "BelGISS")
                try:
                    reg[_key] = int(_val)  # в логе кумулятивные тоталы — присваиваем
                except ValueError:
                    pass
            self.state.tick_activity()
        # Путь к выходному файлу
        m = OUTPUT_RX.search(line)
        if m:
            p = Path(m.group(1).strip())
            if not p.is_absolute():
                p = APP_DIR / p
            if p.suffix == ".xlsx":
                name_lower = p.name.lower()
                if "ozon" in name_lower:
                    self.state.ozon_output_path = str(p)
                elif not self.state.output_path:
                    self.state.output_path = str(p)

    def _finalize_paths(self, spec: RunSpec) -> None:
        """Определяет итоговые пути к XLSX и лог-файлу после завершения прогона."""
        if not self.state.output_path:
            out_name = spec.output or {
                "query_stage1": "links.xlsx",
                "query_stage2": "result.xlsx",
                "query_full": "result.xlsx",
                "brand": "brand_result.xlsx",
                "ozon": "ozon_result.xlsx",
                "unified": "unified_result.xlsx",
            }.get(spec.mode, "result.xlsx")
            p = Path(out_name)
            if not p.is_absolute():
                p = APP_DIR / p
            if p.exists():
                self.state.output_path = str(p)

        # Для ozon-only режима: явно выставляем ozon_output_path к общему файлу,
        # чтобы кнопка «Ozon XLSX» заработала. Парсер всегда пишет файл (даже диагностический).
        if spec.mode == "ozon" and self.state.output_path and not self.state.ozon_output_path:
            self.state.ozon_output_path = self.state.output_path

        # Лог-файл рядом с xlsx
        if self.state.output_path:
            p = Path(self.state.output_path)
            lp = p.with_name(p.stem + "_run.log")
            if lp.exists():
                self.state.log_path = str(lp)
            # Парсим Сводку из xlsx
            self._parse_summary(p)

    def _parse_summary(self, xlsx_path: Path) -> None:
        """Читает лист 'Сводка' из XLSX и заполняет metrics.status/risk/registry."""
        try:
            from openpyxl import load_workbook  # type: ignore
            wb = load_workbook(xlsx_path, read_only=True, data_only=True)
            if "Сводка" not in wb.sheetnames:
                return
            ws = wb["Сводка"]
            status: Dict[str, int] = {}
            risk: Dict[str, int] = {}
            registry: Dict[str, int] = {}
            section = None
            for row in ws.iter_rows(values_only=True):
                cells = [c for c in row if c is not None]
                if not cells:
                    section = None
                    continue
                head = str(cells[0])
                if "Распределение по техническому статусу" in head:
                    section = "status"
                    continue
                if "Риски по сроку" in head:
                    section = "risk"
                    continue
                if "Реестр" in head or "По реестрам" in head:
                    section = "registry"
                    continue
                if section in ("status", "risk", "registry") and len(cells) >= 2:
                    if head in ("Статус", "Категория", "Реестр"):
                        continue
                    try:
                        cnt = int(cells[1])
                        if section == "status":
                            status[head] = cnt
                        elif section == "risk":
                            risk[head] = cnt
                        elif section == "registry":
                            registry[head] = cnt
                    except Exception:
                        pass
            if status:
                self.state.metrics["status"] = status
            if risk:
                self.state.metrics["risk"] = risk
            if registry:
                self.state.metrics["registry"] = registry
            # Обнаружение диагностического xlsx (Ozon вернул 0 товаров)
            if "Диагностика" in wb.sheetnames:
                ws_d = wb["Диагностика"]
                diag_msg = ""
                for row in ws_d.iter_rows(values_only=True):
                    if row and row[0] and str(row[0]).strip() == "diagnosis" and len(row) > 1:
                        diag_msg = str(row[1] or "")
                        break
                if diag_msg:
                    self.state.log_lines.append(f"[⚠️ Ozon] {diag_msg}")
                    self.state.metrics["ozon_diagnosis"] = diag_msg
        except Exception as exc:
            self.state.log_lines.append(f"[summary parse fail] {exc}")


# ---------------------------------------------------------------------------
# merge_xlsx — объединение WB + Ozon отчётов
# ---------------------------------------------------------------------------

def merge_xlsx(wb_xlsx: Path, ozon_xlsx: Path, output_xlsx: Path) -> None:
    """
    Сливает два отчёта WB и Ozon в единый XLSX.

    Структура итогового файла:
    - Подробности (общий лист с колонкой «Маркетплейс»)
    - Подробности WB (исходный лист)
    - Подробности Ozon (исходный лист)
    - Сводка (объединённая статистика)
    """
    try:
        from openpyxl import load_workbook, Workbook  # type: ignore
        from openpyxl.styles import PatternFill, Font, Alignment  # type: ignore
    except ImportError as exc:
        raise RuntimeError(f"openpyxl не установлен: {exc}") from exc

    def read_sheet(path: Path, sheet_hint: str = "Подробности") -> Tuple[List[str], List[List]]:
        """Читает указанный лист или первый доступный."""
        if not path.exists():
            return [], []
        wb = load_workbook(path, read_only=True, data_only=True)
        sheet = None
        for name in (sheet_hint, "results", wb.sheetnames[0] if wb.sheetnames else None):
            if name and name in wb.sheetnames:
                sheet = wb[name]
                break
        if sheet is None:
            return [], []
        headers: List[str] = []
        rows: List[List] = []
        for i, row in enumerate(sheet.iter_rows(values_only=True)):
            if i == 0:
                headers = [str(c) if c is not None else "" for c in row]
            else:
                rows.append([c if c is not None else "" for c in row])
        return headers, rows

    wb_headers, wb_rows = read_sheet(wb_xlsx)
    oz_headers, oz_rows = read_sheet(ozon_xlsx)

    out = Workbook()
    out.remove(out.active)  # удаляем дефолтный лист

    header_fill = PatternFill("solid", fgColor="1E1F29")
    header_font = Font(bold=True, color="FFFFFF")

    def write_sheet(ws, headers: List[str], rows: List[List]) -> None:
        ws.append(headers)
        for cell in ws[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center")
        for row in rows:
            ws.append(row)

    # Лист «Подробности» — объединённый с колонкой «Маркетплейс»
    ws_all = out.create_sheet("Подробности")
    mp_col = "Маркетплейс"
    all_headers = [mp_col] + wb_headers if wb_headers else [mp_col] + oz_headers
    wb_header_set = set(wb_headers)
    oz_header_set = set(oz_headers)
    # Добавляем уникальные Ozon-колонки
    for h in oz_headers:
        if h not in wb_header_set and h not in all_headers:
            all_headers.append(h)

    write_sheet(ws_all, all_headers, [])
    # Убираем заголовки (уже записаны), добавляем данные
    # WB строки
    for row in wb_rows:
        padded = ["WB"] + list(row) + [""] * (len(all_headers) - len(row) - 1)
        ws_all.append(padded[:len(all_headers)])
    # Ozon строки — маппим по заголовкам
    for row in oz_rows:
        oz_dict = dict(zip(oz_headers, row))
        new_row = ["Ozon"] + [oz_dict.get(h, "") for h in all_headers[1:]]
        ws_all.append(new_row[:len(all_headers)])

    # Отдельные листы
    if wb_rows:
        ws_wb = out.create_sheet("Подробности WB")
        write_sheet(ws_wb, wb_headers, wb_rows)

    if oz_rows:
        ws_oz = out.create_sheet("Подробности Ozon")
        write_sheet(ws_oz, oz_headers, oz_rows)

    # Сводный лист
    ws_sum = out.create_sheet("Сводка")
    ws_sum.append(["Параметр", "Значение"])
    ws_sum.append(["WB карточек", len(wb_rows)])
    ws_sum.append(["Ozon карточек", len(oz_rows)])
    ws_sum.append(["Всего карточек", len(wb_rows) + len(oz_rows)])
    ws_sum.append(["Дата объединения", time.strftime("%Y-%m-%d %H:%M:%S")])

    out.save(str(output_xlsx))
    log.info("Unified XLSX сохранён: %s", output_xlsx)


# ---------------------------------------------------------------------------
# Bridge API (JS ↔ Python)
# ---------------------------------------------------------------------------

class Bridge:
    """Методы Bridge, доступные из JS как window.pywebview.api.*"""

    def __init__(self) -> None:
        self.state = AppState()
        self.runner = EngineRunner(self.state)
        s = load_settings()
        self._last_spec: dict = s.get("last_spec", {})
        self._missing_deps: List[str] = []

    def diagnose(self) -> dict:
        """Возвращает диагностику: python, движки, зависимости, последняя команда."""
        return {
            "ok": True,
            "app_version": APP_VERSION,
            "python": sys.executable,
            "python_version": sys.version.split()[0],
            "platform": platform.platform(),
            "app_dir": str(APP_DIR),
            "engines": {
                "main_v39.py": ENGINE_V39.exists(),
                "main_brand.py": ENGINE_BRAND.exists(),
                "ozon_parser.py": ENGINE_OZON.exists(),
                "wb_enhanced.py": ENGINE_WB_ENHANCED.exists(),
                "fsa_enhanced.py": ENGINE_FSA_ENHANCED.exists(),
            },
            "missing_deps": self._missing_deps,
            "last_cmd": self.state.last_cmd,
            "last_error": self.state.error,
        }

    # ---- статус ----

    def get_state(self) -> dict:
        """Возвращает полное состояние прогона для фронтенда."""
        return self.state.to_dict()

    def get_log_lines(self, offset: int = 0) -> dict:
        """Возвращает порцию лога начиная с offset (для инкрементального polling)."""
        offset = max(0, int(offset))
        chunk = self.state.log_lines[offset: offset + 500]
        return {
            "from": offset,
            "total": len(self.state.log_lines),
            "lines": chunk,
        }

    def get_version(self) -> dict:
        """Возвращает версию приложения и статус наличия движков."""
        return {
            "app_version": APP_VERSION,
            "engine_v39": str(ENGINE_V39),
            "engine_v39_exists": ENGINE_V39.exists(),
            "engine_brand": str(ENGINE_BRAND),
            "engine_brand_exists": ENGINE_BRAND.exists(),
            "engine_ozon": str(ENGINE_OZON),
            "engine_ozon_exists": ENGINE_OZON.exists(),
            "engine_wb_enhanced_exists": ENGINE_WB_ENHANCED.exists(),
            "engine_fsa_enhanced_exists": ENGINE_FSA_ENHANCED.exists(),
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "platform": platform.system(),
            "app_dir": str(APP_DIR),
        }

    # ---- настройки ----

    def get_settings(self) -> dict:
        """Загружает и возвращает текущие настройки."""
        return load_settings()

    def save_settings(self, data: dict) -> dict:
        """Сохраняет настройки полностью."""
        s = load_settings()
        s.update(data or {})
        save_settings(s)
        return {"ok": True}

    def get_last_spec(self) -> dict:
        """Возвращает последний использованный RunSpec."""
        return dict(self._last_spec or {})

    # ---- запуск ----

    def start_run(self, spec: dict) -> dict:
        """Запускает прогон по переданным параметрам."""
        if self.state.running:
            return {"ok": False, "error": "Прогон уже выполняется"}
        spec = spec or {}
        # Фильтруем только известные поля
        valid_keys = set(RunSpec.__dataclass_fields__.keys())
        filtered = {k: v for k, v in spec.items() if k in valid_keys}
        try:
            run_spec = RunSpec(**filtered)
        except Exception as exc:
            return {"ok": False, "error": f"Неверные параметры: {exc}"}

        # Валидация
        mode = run_spec.mode
        if mode in ("query_full", "query_stage1", "ozon", "unified") and not run_spec.query.strip():
            return {"ok": False, "error": "Укажите поисковый запрос"}
        if mode == "brand" and not run_spec.brand.strip():
            return {"ok": False, "error": "Укажите название бренда"}
        if mode in ("query_full", "query_stage1", "query_stage2") and not ENGINE_V39.exists():
            return {"ok": False, "error": f"Движок WB Query не найден: {ENGINE_V39.name}"}
        if mode == "brand" and not ENGINE_BRAND.exists():
            return {"ok": False, "error": f"Движок WB Brand не найден: {ENGINE_BRAND.name}"}
        if mode in ("ozon", "unified") and not ENGINE_OZON.exists():
            return {"ok": False, "error": f"Движок Ozon не найден: {ENGINE_OZON.name}"}
        if mode == "unified" and not ENGINE_V39.exists():
            return {"ok": False, "error": f"Движок WB Query не найден для unified-режима: {ENGINE_V39.name}"}

        # Сохраняем последний spec
        self._last_spec = spec
        s = load_settings()
        s["last_spec"] = spec
        save_settings(s)

        try:
            self.runner.start(run_spec)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True}

    def stop_run(self) -> dict:
        """Останавливает текущий прогон."""
        self.runner.stop()
        return {"ok": True}

    # ---- результаты ----

    def get_results(self, xlsx_path: Optional[str] = None, limit: int = 2000) -> dict:
        """
        Читает лист «Подробности» из XLSX и возвращает данные для таблицы.
        Также считает статистику по статусу, реестру и маркетплейсу.
        """
        path = Path(xlsx_path or self.state.output_path or "")
        if not path.exists():
            return {"ok": False, "error": "Файл результата не найден. Запустите прогон."}
        try:
            from openpyxl import load_workbook  # type: ignore
            wb = load_workbook(path, read_only=True, data_only=True)
            sheet_name = "Подробности"
            if sheet_name not in wb.sheetnames:
                for candidate in ("results", wb.sheetnames[0] if wb.sheetnames else None):
                    if candidate and candidate in wb.sheetnames:
                        sheet_name = candidate
                        break
            ws = wb[sheet_name]
            headers: List[str] = []
            rows: List[List] = []
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i == 0:
                    headers = [str(c) if c is not None else "" for c in row]
                elif i <= limit:
                    rows.append([(c if c is not None else "") for c in row])
                else:
                    break
            total_rows = (ws.max_row or 1) - 1

            # Статистика
            stats: Dict[str, Any] = {
                "by_status": {}, "by_registry": {}, "by_marketplace": {},
                "by_original": {}, "by_doc_status": {}, "by_brand": {},
                "by_risk": {},
            }
            h_lower = [h.lower() for h in headers]

            def find_col(*needles: str) -> Optional[int]:
                # Ищем точное совпадение сначала, потом фрагмент
                for needle in needles:
                    if needle in h_lower:
                        return h_lower.index(needle)
                for needle in needles:
                    for i, h in enumerate(h_lower):
                        if needle in h:
                            return i
                return None

            def _host_of(url: str) -> str:
                try:
                    from urllib.parse import urlparse
                    return (urlparse(url).hostname or "").replace("www.", "")
                except Exception:
                    return url

            try:
                idx_status      = find_col("технический статус", "status", "статус")
                idx_registry    = find_col("registry_host", "реестр (host)", "registry_url")
                idx_marketplace = find_col("marketplace", "маркетплейс")
                idx_original    = find_col("is_original", "оригинал")
                idx_docstatus   = find_col("document_status", "статус документа")
                idx_brand       = find_col("brand", "бренд")
                idx_risk        = find_col("риск по сроку", "риск", "risk")
                # Если маркетплейс не в файле — определяем по product_url
                idx_purl = find_col("product_url")
                for row in rows:
                    if idx_status is not None and idx_status < len(row):
                        v = str(row[idx_status] or "").strip()
                        if v: stats["by_status"][v] = stats["by_status"].get(v, 0) + 1
                    if idx_registry is not None and idx_registry < len(row):
                        v = str(row[idx_registry] or "").strip()
                        if v.startswith("http"):
                            v = _host_of(v)
                        if v: stats["by_registry"][v] = stats["by_registry"].get(v, 0) + 1
                    if idx_marketplace is not None and idx_marketplace < len(row):
                        v = str(row[idx_marketplace] or "").strip()
                        if v: stats["by_marketplace"][v] = stats["by_marketplace"].get(v, 0) + 1
                    elif idx_purl is not None and idx_purl < len(row):
                        u = str(row[idx_purl] or "").lower()
                        if "wildberries" in u: mk = "Wildberries"
                        elif "ozon" in u: mk = "Ozon"
                        else: mk = "Не определен"
                        stats["by_marketplace"][mk] = stats["by_marketplace"].get(mk, 0) + 1
                    if idx_original is not None and idx_original < len(row):
                        v = str(row[idx_original] or "").strip()
                        # Нормализуем в два стабильных значения
                        vl = v.lower()
                        if vl in ("true", "да", "оригинал"):
                            key = "Оригинал"
                        elif vl in ("false", "нет"):
                            key = "Не оригинал"
                        elif not v or vl in ("не указано", "none"):
                            key = "Не указано"
                        else:
                            key = v
                        stats["by_original"][key] = stats["by_original"].get(key, 0) + 1
                    if idx_docstatus is not None and idx_docstatus < len(row):
                        v = str(row[idx_docstatus] or "").strip()
                        if v: stats["by_doc_status"][v] = stats["by_doc_status"].get(v, 0) + 1
                    if idx_brand is not None and idx_brand < len(row):
                        v = str(row[idx_brand] or "").strip()
                        if v: stats["by_brand"][v] = stats["by_brand"].get(v, 0) + 1
                    if idx_risk is not None and idx_risk < len(row):
                        v = str(row[idx_risk] or "").strip()
                        if v: stats["by_risk"][v] = stats["by_risk"].get(v, 0) + 1
                # Обрезаем by_brand до топ-12, остальные в «Прочее»
                if len(stats["by_brand"]) > 12:
                    sb = sorted(stats["by_brand"].items(), key=lambda kv: -kv[1])
                    top = dict(sb[:11])
                    rest = sum(v for _, v in sb[11:])
                    if rest > 0:
                        top["Прочее"] = rest
                    stats["by_brand"] = top
            except Exception as exc:
                log.warning("Сборка статистики не удалась: %s", exc)

            return {
                "ok": True,
                "sheet": sheet_name,
                "columns": headers,
                "rows": rows,
                "total": total_rows,
                "stats": stats,
                "xlsx_path": str(path),
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def open_path(self, path: str) -> dict:
        """Открывает файл или папку в системном проводнике/приложении."""
        try:
            target = Path(path)
            if not target.exists():
                return {"ok": False, "error": f"Путь не найден: {path}"}
            if sys.platform == "win32":
                os.startfile(str(target))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(target)])
            else:
                subprocess.Popen(["xdg-open", str(target)])
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def open_workspace(self) -> dict:
        """Открывает рабочую папку программы."""
        return self.open_path(str(APP_DIR))

    def export_csv(self, xlsx_path: Optional[str] = None, filter_text: str = "") -> dict:
        """
        Экспортирует отфильтрованные данные из XLSX в CSV.
        Возвращает путь к сохранённому CSV-файлу.
        """
        res = self.get_results(xlsx_path)
        if not res.get("ok"):
            return res
        rows = res["rows"]
        headers = res["columns"]
        q = filter_text.lower().strip() if filter_text else ""
        if q:
            rows = [r for r in rows if any(q in str(c).lower() for c in r)]
        ts = time.strftime("%Y%m%d_%H%M%S")
        out_path = APP_DIR / f"export_{ts}.csv"
        try:
            with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(headers)
                writer.writerows(rows)
            return {"ok": True, "path": str(out_path), "rows": len(rows)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Frontend HTML/CSS/JS
# ---------------------------------------------------------------------------

FRONTEND_HTML = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WB+Ozon Checker v27</title>
<style>
/* ===================== CSS Variables ===================== */
:root {
  --bg:       #0a0a0f;
  --surface:  #15161d;
  --card:     #1e1f29;
  --card2:    #252636;
  --border:   rgba(255,255,255,0.08);
  --border2:  rgba(255,255,255,0.12);
  --fg:       #e8eaf2;
  --fg2:      #a0a3b1;
  --muted:    #6b6e82;
  --accent:   #5b8cff;
  --accent2:  #4070e0;
  --accent3:  #3a5fbf;
  --success:  #10b981;
  --warning:  #f59e0b;
  --error:    #ef4444;
  --info:     #38bdf8;
  --ozon:     #005bff;
  --wb:       #cb11ab;
}
[data-theme="light"] {
  --bg:       #f5f6fa;
  --surface:  #ffffff;
  --card:     #ffffff;
  --card2:    #f0f1f8;
  --border:   rgba(0,0,0,0.1);
  --border2:  rgba(0,0,0,0.15);
  --fg:       #111827;
  --fg2:      #374151;
  --muted:    #6b7280;
  --accent:   #3b6ff5;
  --accent2:  #2d5de0;
}

/* ===================== Reset ===================== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  height: 100%; overflow: hidden;
  background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", sans-serif;
  font-size: 14px; line-height: 1.5;
}

/* ===================== Layout ===================== */
.app { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }

/* ===================== Sidebar ===================== */
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.sidebar-logo {
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--border);
}
.sidebar-logo .brand-name {
  font-size: 16px; font-weight: 700; letter-spacing: -0.3px;
  background: linear-gradient(135deg, var(--accent), #a78bfa);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.sidebar-logo .brand-sub { font-size: 11px; color: var(--muted); margin-top: 3px; }
.nav { padding: 10px 8px; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.nav-btn {
  background: transparent; border: none; color: var(--fg2);
  padding: 10px 12px; text-align: left; cursor: pointer;
  border-radius: 8px; font-size: 13px; font-family: inherit;
  display: flex; align-items: center; gap: 10px;
  transition: background 0.15s ease, color 0.15s ease;
  width: 100%;
}
.nav-btn:hover { background: var(--card); color: var(--fg); }
.nav-btn.active {
  background: rgba(91,140,255,0.15);
  color: var(--accent);
}
.nav-btn.active .nav-ico { opacity: 1; }
.nav-ico { font-size: 16px; width: 20px; text-align: center; flex-shrink: 0; }
.nav-label { flex: 1; }
.nav-badge {
  font-size: 10px; font-weight: 600;
  background: var(--accent); color: white;
  border-radius: 10px; padding: 1px 6px;
  display: none;
}
.nav-badge.visible { display: inline-block; }
.sidebar-footer {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px; color: var(--muted);
  line-height: 1.6;
}
.sidebar-footer .engine-dot {
  display: inline-block; width: 7px; height: 7px;
  border-radius: 50%; background: var(--muted);
  margin-right: 4px;
}
.engine-dot.ok { background: var(--success); }
.engine-dot.miss { background: var(--error); }

/* ===================== Main area ===================== */
.main { display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 22px;
  height: 56px;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.topbar-left { display: flex; align-items: center; gap: 12px; }
.topbar-title { font-size: 16px; font-weight: 600; }
.topbar-right { display: flex; align-items: center; gap: 16px; }
.status-indicator {
  display: flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--muted);
}
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--muted); flex-shrink: 0;
}
.status-dot.running {
  background: var(--accent);
  animation: pulse-dot 1.4s ease-in-out infinite;
}
.status-dot.ok { background: var(--success); }
.status-dot.error { background: var(--error); }
@keyframes pulse-dot {
  0%, 100% { box-shadow: 0 0 0 0 rgba(91,140,255,0.5); }
  50% { box-shadow: 0 0 0 5px rgba(91,140,255,0); }
}
.content {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 22px; scroll-behavior: smooth;
}
/* Custom scrollbar */
.content::-webkit-scrollbar,
.log-view::-webkit-scrollbar,
.tbl-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
.content::-webkit-scrollbar-track,
.log-view::-webkit-scrollbar-track,
.tbl-wrap::-webkit-scrollbar-track { background: transparent; }
.content::-webkit-scrollbar-thumb,
.log-view::-webkit-scrollbar-thumb,
.tbl-wrap::-webkit-scrollbar-thumb {
  background: var(--card2); border-radius: 4px;
}
.content::-webkit-scrollbar-thumb:hover,
.log-view::-webkit-scrollbar-thumb:hover,
.tbl-wrap::-webkit-scrollbar-thumb:hover { background: var(--border2); }

/* ===================== Screens ===================== */
.screen { display: none; }
.screen.active {
  display: block;
  animation: fadeUp 0.18s ease-out;
}
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ===================== Cards ===================== */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 13.5px; font-weight: 600; color: var(--fg);
  margin-bottom: 14px;
  display: flex; align-items: center; gap: 8px;
}
.card-title .ctag {
  font-size: 10px; font-weight: 500; padding: 2px 7px;
  border-radius: 10px; background: rgba(91,140,255,0.15); color: var(--accent);
}

/* ===================== KPI Grid ===================== */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.kpi-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  position: relative;
  overflow: hidden;
}
.kpi-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: var(--kpi-color, var(--accent));
}
.kpi-label {
  font-size: 11px; font-weight: 500;
  color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.6px; margin-bottom: 8px;
}
.kpi-value {
  font-size: 26px; font-weight: 700;
  color: var(--kpi-color, var(--fg));
  line-height: 1;
}
.kpi-sub { font-size: 11.5px; color: var(--muted); margin-top: 5px; }

/* ===================== Segmented Control / Tabs ===================== */
.seg-ctrl {
  display: inline-flex;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px; padding: 4px; gap: 2px;
  margin-bottom: 16px;
}
.seg-btn {
  background: transparent; border: none;
  color: var(--muted); cursor: pointer;
  padding: 8px 16px; border-radius: 7px;
  font-size: 13px; font-family: inherit;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}
.seg-btn:hover { color: var(--fg); }
.seg-btn.active { background: var(--accent); color: white; }
.seg-btn .mkt-tag {
  font-size: 10px; opacity: 0.75; margin-left: 5px;
}

/* ===================== Form fields ===================== */
.form-grid {
  display: grid; gap: 14px 18px;
}
.form-grid.cols-2 { grid-template-columns: 1fr 1fr; }
.form-grid.cols-3 { grid-template-columns: 1fr 1fr 1fr; }

.field {
  display: flex; flex-direction: column; gap: 5px;
}
.field-label {
  font-size: 12px; font-weight: 500; color: var(--fg2);
}
.field-hint { font-size: 11px; color: var(--muted); margin-top: -2px; }
.field input[type=text],
.field input[type=number],
.field select {
  background: var(--surface);
  border: 1px solid var(--border2);
  color: var(--fg);
  padding: 9px 12px; border-radius: 8px;
  font-size: 13.5px; font-family: inherit;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  width: 100%;
}
.field input:focus,
.field select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(91,140,255,0.12);
}
.field select option { background: var(--surface); }

/* Toggle Switch */
.toggle-wrap {
  display: flex; align-items: center; gap: 10px; cursor: pointer;
}
.toggle-wrap input[type=checkbox] { display: none; }
.toggle-track {
  width: 38px; height: 22px; border-radius: 12px;
  background: var(--card2); border: 1px solid var(--border2);
  position: relative; transition: background 0.2s, border-color 0.2s;
  flex-shrink: 0;
}
.toggle-track::after {
  content: '';
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--muted); transition: left 0.2s, background 0.2s;
}
.toggle-wrap input:checked + .toggle-track {
  background: var(--accent); border-color: var(--accent);
}
.toggle-wrap input:checked + .toggle-track::after {
  left: 18px; background: white;
}
.toggle-label { font-size: 13px; color: var(--fg2); user-select: none; }
.toggle-sub { font-size: 11px; color: var(--muted); }

/* ===================== Buttons ===================== */
.btn {
  display: inline-flex; align-items: center; gap: 7px;
  border: none; cursor: pointer;
  padding: 10px 20px; border-radius: 8px;
  font-size: 13.5px; font-weight: 500; font-family: inherit;
  transition: background 0.15s, transform 0.08s, box-shadow 0.15s;
  white-space: nowrap;
}
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none !important; }
.btn-primary {
  background: var(--accent); color: white;
  box-shadow: 0 2px 8px rgba(91,140,255,0.3);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent2);
  box-shadow: 0 4px 12px rgba(91,140,255,0.4);
}
.btn-danger { background: var(--error); color: white; }
.btn-danger:hover:not(:disabled) { background: #dc2626; }
.btn-ghost {
  background: transparent; color: var(--fg2);
  border: 1px solid var(--border2);
}
.btn-ghost:hover:not(:disabled) { background: var(--card); color: var(--fg); }
.btn-lg { padding: 13px 28px; font-size: 14.5px; }
.btn-sm { padding: 7px 14px; font-size: 12.5px; }

.actions-row {
  display: flex; flex-wrap: wrap; gap: 10px;
  align-items: center; margin-top: 16px;
}

/* ===================== Progress ===================== */
.progress-wrap { margin: 12px 0 16px; }
.progress-bar-bg {
  height: 8px; background: var(--card2); border-radius: 4px; overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent) 0%, #a78bfa 100%);
  width: 0%; border-radius: 4px;
  transition: width 0.3s ease;
}
.progress-info {
  display: flex; justify-content: space-between;
  font-size: 12px; color: var(--muted); margin-top: 7px;
}

/* ===================== Chart containers ===================== */
.charts-row {
  display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px;
  margin-bottom: 16px;
}
.chart-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
.chart-card .chart-title {
  font-size: 12px; font-weight: 600; color: var(--fg2);
  margin-bottom: 12px;
}
.chart-canvas-wrap { position: relative; height: 180px; }
.chart-fallback {
  height: 180px; display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 12px; text-align: center;
}

/* Activity sparkline */
.activity-chart-wrap {
  position: relative; height: 80px;
  background: var(--card2); border-radius: 8px;
  overflow: hidden; margin-top: 10px;
}

/* ===================== Badges ===================== */
.badge {
  display: inline-flex; align-items: center;
  padding: 3px 9px; border-radius: 5px;
  font-size: 11.5px; font-weight: 500; white-space: nowrap;
}
.badge-ok      { background: rgba(16,185,129,0.12); color: var(--success); }
.badge-warn    { background: rgba(245,158,11,0.12); color: var(--warning); }
.badge-error   { background: rgba(239,68,68,0.12);  color: var(--error); }
.badge-info    { background: rgba(56,189,248,0.12); color: var(--info); }
.badge-muted   { background: var(--card2); color: var(--muted); }
.badge-accent  { background: rgba(91,140,255,0.12); color: var(--accent); }
.badge-wb      { background: rgba(203,17,171,0.12); color: var(--wb); }
.badge-ozon    { background: rgba(0,91,255,0.12);   color: var(--ozon); }

.badge-group { display: flex; flex-wrap: wrap; gap: 6px; }

/* ===================== Table ===================== */
.tbl-wrap {
  overflow: auto;
  max-height: calc(100vh - 280px);
  border: 1px solid var(--border);
  border-radius: 10px;
}
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
thead th {
  position: sticky; top: 0; z-index: 1;
  background: var(--surface); padding: 10px 12px;
  text-align: left; font-weight: 600; font-size: 11.5px;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px;
  border-bottom: 1px solid var(--border2); white-space: nowrap;
}
tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--fg2); max-width: 280px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
tbody tr:hover td { background: var(--card); color: var(--fg); }
tbody tr:last-child td { border-bottom: none; }

/* ===================== Log ===================== */
.log-toolbar {
  display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
  flex-wrap: wrap;
}
.log-filter-btns { display: flex; gap: 4px; }
.log-filter-btn {
  background: var(--card); border: 1px solid var(--border);
  color: var(--muted); padding: 4px 10px; border-radius: 6px;
  font-size: 11.5px; cursor: pointer; font-family: inherit;
  transition: background 0.12s, color 0.12s;
}
.log-filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
.log-view {
  background: #09090e;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
  font-size: 12px; line-height: 1.55;
  padding: 14px; overflow: auto;
  height: calc(100vh - 220px);
  white-space: pre-wrap; word-break: break-all;
}
.log-line-err  { color: #f87171; }
.log-line-warn { color: #fbbf24; }
.log-line-ok   { color: #34d399; }
.log-line-info { color: #94a3b8; }
.log-line-head { color: var(--accent); font-weight: 700; }
.log-line-cmd  { color: #64748b; font-style: italic; }

/* ===================== Filter bar ===================== */
.filter-bar {
  display: flex; gap: 10px; align-items: center; margin-bottom: 14px;
}
.filter-bar input {
  flex: 1; background: var(--card); border: 1px solid var(--border2);
  color: var(--fg); padding: 9px 14px; border-radius: 8px;
  font-family: inherit; font-size: 13px; outline: none;
}
.filter-bar input:focus { border-color: var(--accent); }

/* ===================== Empty state ===================== */
.empty-state {
  padding: 60px 20px; text-align: center; color: var(--muted);
}
.empty-state .empty-ico { font-size: 44px; margin-bottom: 14px; opacity: 0.35; }
.empty-state p { font-size: 13.5px; }

/* ===================== Settings ===================== */
.settings-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid var(--border);
}
.settings-row:last-child { border-bottom: none; }
.settings-key { font-size: 13px; color: var(--fg); }
.settings-desc { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.settings-val {
  font-size: 12.5px; color: var(--accent);
  font-family: monospace; text-align: right;
}
.engine-status {
  display: flex; align-items: center; gap: 8px; padding: 8px 0;
  border-bottom: 1px solid var(--border); font-size: 13px;
}
.engine-status:last-child { border-bottom: none; }

/* ===================== Toast notifications ===================== */
#toast-container {
  position: fixed; top: 16px; right: 16px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 9999; pointer-events: none;
}
.toast {
  background: var(--card2); border: 1px solid var(--border2);
  border-radius: 10px; padding: 12px 16px;
  font-size: 13px; color: var(--fg);
  display: flex; align-items: center; gap: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  animation: toastIn 0.25s ease;
  min-width: 240px; max-width: 360px;
  pointer-events: all;
}
.toast.removing { animation: toastOut 0.2s ease forwards; }
.toast-ico { font-size: 16px; flex-shrink: 0; }
.toast.toast-ok   { border-left: 3px solid var(--success); }
.toast.toast-err  { border-left: 3px solid var(--error); }
.toast.toast-info { border-left: 3px solid var(--accent); }
@keyframes toastIn { from { opacity:0; transform: translateX(20px); } to { opacity:1; transform:none; } }
@keyframes toastOut { to { opacity:0; transform: translateX(20px); } }

/* ===================== Misc ===================== */
.divider { height: 1px; background: var(--border); margin: 16px 0; }
.text-muted { color: var(--muted); }
.text-sm { font-size: 12px; }
.ml-auto { margin-left: auto; }
hr.section-sep { border: none; border-top: 1px solid var(--border); margin: 0; }

/* ===================== v27.9.x: Polish (additive) ===================== */
/* Дополняющие правила в конце каскада: глубина, мягкие микро-взаимодействия,
   доступный фокус. Не переопределяют структуру — только визуальный лоск. */
:root { --shadow-1: 0 1px 2px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.22);
        --shadow-2: 0 6px 24px rgba(0,0,0,0.30);
        --ring: 0 0 0 3px rgba(91,140,255,0.35); }
[data-theme="light"] { --shadow-1: 0 1px 2px rgba(16,24,40,0.06), 0 4px 14px rgba(16,24,40,0.08);
        --shadow-2: 0 10px 28px rgba(16,24,40,0.12); }

.card, .kpi-card, .chart-card {
  box-shadow: var(--shadow-1);
  transition: box-shadow 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
  will-change: transform;
}
.kpi-card:hover, .chart-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
  border-color: var(--border2);
}

/* Главная кнопка — мягкий градиент и выразительный hover */
.btn-primary {
  background-image: linear-gradient(135deg, var(--accent), var(--accent2));
}
.btn-primary:hover:not(:disabled) {
  background-image: linear-gradient(135deg, var(--accent), var(--accent3, var(--accent2)));
  transform: translateY(-1px);
}
.btn-lg { box-shadow: 0 4px 14px rgba(91,140,255,0.35); }

/* Доступный фокус по клавиатуре (не мешает мыши) */
.btn:focus-visible, .nav-btn:focus-visible, .seg-btn:focus-visible,
.field input:focus-visible, .field select:focus-visible {
  outline: none; box-shadow: var(--ring);
}

/* Активный пункт меню — аккуратная акцентная полоса слева */
.nav-btn { position: relative; }
.nav-btn.active::before {
  content: ''; position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 3px; border-radius: 0 3px 3px 0; background: var(--accent);
}

/* Числа KPI — моноширинные цифры, чтобы не «прыгали» при обновлении */
.kpi-value { font-variant-numeric: tabular-nums; }

/* Чуть живее переходы экранов */
.screen.active { animation: fadeUp 0.22s cubic-bezier(0.16,1,0.3,1); }
</style>
<!--__CHARTJS_INLINE__-->
</head>
<body>
<div id="toast-container"></div>
<div class="app">

  <!-- ========== SIDEBAR ========== -->
  <aside class="sidebar">
    <div class="sidebar-logo">
      <div class="brand-name">WB+Ozon Checker</div>
      <div class="brand-sub" id="ver-sub">v27.6 · ozon-playwright</div>
    </div>
    <nav class="nav">
      <button class="nav-btn active" data-screen="run">
        <span class="nav-ico">🚀</span>
        <span class="nav-label">Запуск</span>
      </button>
      <button class="nav-btn" data-screen="queue">
        <span class="nav-ico">📋</span>
        <span class="nav-label">Очередь</span>
        <span class="nav-badge" id="queue-badge">●</span>
      </button>
      <button class="nav-btn" data-screen="results">
        <span class="nav-ico">📊</span>
        <span class="nav-label">Результаты</span>
      </button>
      <button class="nav-btn" data-screen="settings">
        <span class="nav-ico">⚙️</span>
        <span class="nav-label">Настройки</span>
      </button>
      <button class="nav-btn" data-screen="logs">
        <span class="nav-ico">📜</span>
        <span class="nav-label">Логи</span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <div id="foot-py">Python …</div>
      <div id="foot-engines" style="margin-top:5px; display:flex; flex-direction:column; gap:3px;"></div>
      <div id="foot-dir" style="margin-top:5px; opacity:0.6; word-break:break-all;"></div>
    </div>
  </aside>

  <!-- ========== MAIN ========== -->
  <main class="main">
    <!-- Topbar -->
    <div class="topbar">
      <div class="topbar-left">
        <span class="topbar-title" id="screen-title">Запуск</span>
      </div>
      <div class="topbar-right">
        <button class="btn btn-sm" id="btn-diagnose" style="margin-right:8px;" title="Диагностика среды">Диагностика</button>
        <div class="status-indicator">
          <div class="status-dot" id="status-dot"></div>
          <span id="status-text">готов</span>
        </div>
      </div>
    </div>
    <div id="deps-banner" style="display:none; background:#3b1d1d; color:#ffb3b3; padding:10px 16px; font-size:13px; border-bottom:1px solid #5a2a2a;">
      <strong>Внимание:</strong> <span id="deps-banner-text"></span>
    </div>

    <div class="content" id="main-content">

      <!-- ========================= RUN SCREEN ========================= -->
      <section class="screen active" id="screen-run">

        <!-- Marketplace selector -->
        <div class="seg-ctrl" id="mkt-sel">
          <button class="seg-btn active" data-mkt="wb">
            <span style="color:var(--wb)">●</span> Wildberries
          </button>
          <button class="seg-btn" data-mkt="ozon">
            <span style="color:var(--ozon)">●</span> Ozon
          </button>
          <button class="seg-btn" data-mkt="both">
            ⚡ Оба
            <span class="mkt-tag">unified</span>
          </button>
        </div>

        <!-- WB mode tabs — скрывается при ozon/both -->
        <div id="wb-mode-row" class="seg-ctrl" style="margin-left:12px; margin-bottom:16px;">
          <button class="seg-btn active" data-mode="query_full">По запросу (полный)</button>
          <button class="seg-btn" data-mode="query_stage1">Только ссылки</button>
          <button class="seg-btn" data-mode="query_stage2">Только реестры (CSV)</button>
          <button class="seg-btn" data-mode="brand">По бренду</button>
        </div>

        <!-- Form card -->
        <div class="card" id="launch-card">
          <div class="card-title" id="form-card-title">
            🔍 По запросу — полный прогон
            <span class="ctag" id="form-mode-tag">WB</span>
          </div>
          <div class="form-grid cols-2" id="form-grid">
            <!-- поля рендерит JS -->
          </div>

          <!-- Enhancements row -->
          <div class="divider"></div>
          <div class="form-grid cols-2" style="margin-top: 0;">
            <div>
              <label class="toggle-wrap">
                <input type="checkbox" id="use-wb-enhanced">
                <div class="toggle-track"></div>
                <div>
                  <div class="toggle-label">wb_enhanced: улучшенный seller_name + «Оригинал»</div>
                  <div class="toggle-sub">Требует wb_enhanced.py</div>
                </div>
              </label>
            </div>
            <div>
              <label class="toggle-wrap">
                <input type="checkbox" id="use-fsa-enhanced">
                <div class="toggle-track"></div>
                <div>
                  <div class="toggle-label">fsa_enhanced: расширенные поля ФСА (54 поля)</div>
                  <div class="toggle-sub">Требует fsa_enhanced.py</div>
                </div>
              </label>
            </div>
          </div>

          <div class="actions-row">
            <button class="btn btn-primary btn-lg" id="btn-run">
              🚀 Запустить
            </button>
            <button class="btn btn-danger" id="btn-stop" disabled>
              ⏹ Остановить
            </button>
            <button class="btn btn-ghost" id="btn-open-folder">
              📁 Папка
            </button>
            <span class="text-muted text-sm ml-auto">Параметры сохраняются автоматически</span>
          </div>
        </div>

        <!-- Last run card -->
        <div class="card" id="last-run-card" style="display:none;">
          <div class="card-title">📂 Последний прогон</div>
          <div id="last-run-info" style="font-size:13px; color:var(--fg2);"></div>
          <div class="actions-row" style="margin-top:12px;">
            <button class="btn btn-ghost btn-sm" id="btn-open-last-xlsx">📄 Открыть XLSX</button>
            <button class="btn btn-ghost btn-sm" id="btn-view-last-results">📊 Таблица</button>
          </div>
        </div>
      </section>


      <!-- ========================= QUEUE SCREEN ========================= -->
      <section class="screen" id="screen-queue">
        <!-- KPI row -->
        <div class="kpi-grid">
          <div class="kpi-card" style="--kpi-color:var(--accent)">
            <div class="kpi-label">Прогресс</div>
            <div class="kpi-value" id="kpi-pct">0%</div>
            <div class="kpi-sub" id="kpi-pct-sub">— из —</div>
          </div>
          <div class="kpi-card" style="--kpi-color:var(--fg)">
            <div class="kpi-label">Прошло</div>
            <div class="kpi-value" id="kpi-elapsed">—</div>
            <div class="kpi-sub" id="kpi-mode-lbl">—</div>
          </div>
          <div class="kpi-card" style="--kpi-color:var(--success)">
            <div class="kpi-label">Скорость</div>
            <div class="kpi-value" id="kpi-speed">—</div>
            <div class="kpi-sub">строк/мин</div>
          </div>
          <div class="kpi-card" style="--kpi-color:var(--error)">
            <div class="kpi-label">Ошибок</div>
            <div class="kpi-value" id="kpi-errors">0</div>
            <div class="kpi-sub" id="kpi-ok-sub">OK: 0</div>
          </div>
        </div>

        <!-- Progress card -->
        <div class="card">
          <div class="card-title">📈 Прогресс выполнения</div>
          <div class="progress-wrap">
            <div class="progress-bar-bg">
              <div class="progress-bar-fill" id="prog-bar"></div>
            </div>
            <div class="progress-info">
              <span id="prog-label">ожидание</span>
              <span id="prog-stage" style="color:var(--accent);"></span>
            </div>
          </div>
          <!-- Стек-бар по статусам (визуальный расклад результата) -->
          <div id="status-stack" style="display:flex; height:14px; width:100%; border-radius:4px; overflow:hidden; margin-top:14px; background:rgba(255,255,255,0.04);">
          </div>
          <div id="status-stack-legend" style="display:flex; flex-wrap:wrap; gap:14px; margin-top:10px; font-size:12px; color:var(--fg2);"></div>
          <div class="actions-row" style="margin-top:14px;">
            <button class="btn btn-ghost btn-sm" id="btn-open-result" disabled>📄 Открыть XLSX</button>
            <button class="btn btn-ghost btn-sm" id="btn-open-ozon-result" disabled>🛒 Ozon XLSX</button>
            <button class="btn btn-ghost btn-sm" id="btn-open-log" disabled>📝 Лог файл</button>
            <button class="btn btn-ghost btn-sm" id="btn-goto-results">📊 Таблица</button>
          </div>
        </div>

        <!-- v27.6: Live-лог (последние ~30 строк stdout) -->
        <div class="card">
          <div class="card-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span>📝 Живой лог</span>
            <span style="font-size:11px; color:var(--fg2); font-weight:normal;" id="livelog-total">0 строк</span>
          </div>
          <div id="livelog-box" style="max-height:240px; overflow-y:auto; background:rgba(0,0,0,0.25); border-radius:6px; padding:10px 12px; font-family:'JetBrains Mono', Consolas, monospace; font-size:11.5px; line-height:1.45; color:#cfd6e0; white-space:pre-wrap; word-break:break-word;">Ожидание запуска…</div>
        </div>

        <!-- Charts row -->
        <div class="charts-row">
          <div class="chart-card">
            <div class="chart-title">Технический статус</div>
            <div class="chart-canvas-wrap">
              <canvas id="chart-status"></canvas>
              <div class="chart-fallback" id="chart-status-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Реестры</div>
            <div class="chart-canvas-wrap">
              <canvas id="chart-registry"></canvas>
              <div class="chart-fallback" id="chart-registry-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Маркетплейсы</div>
            <div class="chart-canvas-wrap">
              <canvas id="chart-marketplace"></canvas>
              <div class="chart-fallback" id="chart-marketplace-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Оригинальность</div>
            <div class="chart-canvas-wrap">
              <canvas id="chart-original"></canvas>
              <div class="chart-fallback" id="chart-original-fb" style="display:none;">нет данных</div>
            </div>
          </div>
        </div>
      </section>


      <!-- ========================= RESULTS SCREEN ========================= -->
      <section class="screen" id="screen-results">
        <!-- Charts -->
        <div class="charts-row" id="results-charts-row">
          <div class="chart-card">
            <div class="chart-title">Технический статус</div>
            <div class="chart-canvas-wrap">
              <canvas id="res-chart-status"></canvas>
              <div class="chart-fallback" id="res-chart-status-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Реестры</div>
            <div class="chart-canvas-wrap">
              <canvas id="res-chart-registry"></canvas>
              <div class="chart-fallback" id="res-chart-registry-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Маркетплейсы</div>
            <div class="chart-canvas-wrap">
              <canvas id="res-chart-marketplace"></canvas>
              <div class="chart-fallback" id="res-chart-marketplace-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Оригинальность</div>
            <div class="chart-canvas-wrap">
              <canvas id="res-chart-original"></canvas>
              <div class="chart-fallback" id="res-chart-original-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Риск по сроку</div>
            <div class="chart-canvas-wrap">
              <canvas id="res-chart-risk"></canvas>
              <div class="chart-fallback" id="res-chart-risk-fb" style="display:none;">нет данных</div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Топ брендов</div>
            <div class="chart-canvas-wrap">
              <canvas id="res-chart-brand"></canvas>
              <div class="chart-fallback" id="res-chart-brand-fb" style="display:none;">нет данных</div>
            </div>
          </div>
        </div>

        <!-- Filter + table -->
        <div class="filter-bar">
          <input type="text" id="filter-input"
                 placeholder="🔍  Поиск по названию, бренду, артикулу, статусу…">
          <select id="filter-status" class="btn btn-ghost btn-sm" style="padding:8px 12px;">
            <option value="">Все статусы</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="btn-reload-results">⟳ Обновить</button>
          <button class="btn btn-ghost btn-sm" id="btn-export-csv">⬇ CSV</button>
          <span class="text-muted text-sm" id="results-count"></span>
        </div>

        <div class="tbl-wrap" id="tbl-wrap">
          <div class="empty-state">
            <div class="empty-ico">📋</div>
            <p>Результатов пока нет.<br>Запустите прогон и нажмите «Результаты».</p>
          </div>
        </div>
      </section>


      <!-- ========================= SETTINGS SCREEN ========================= -->
      <section class="screen" id="screen-settings">
        <div class="card">
          <div class="card-title">🔖 О программе</div>
          <div id="settings-version-info" style="font-size:13px; color:var(--fg2); line-height:1.7;"></div>
        </div>

        <div class="card">
          <div class="card-title">⚙️ Движки</div>
          <div id="settings-engines"></div>
        </div>

        <div class="card">
          <div class="card-title">🎛 Параметры по умолчанию</div>
          <div class="form-grid cols-2">
            <div class="field">
              <span class="field-label">expiry_warning_days</span>
              <input type="number" id="s-expiry" value="30" min="1" max="365">
              <span class="field-hint">Порог «Скоро истекает» (дней)</span>
            </div>
            <div class="field">
              <span class="field-label">Воркеры по умолчанию</span>
              <input type="number" id="s-workers" value="4" min="1" max="20">
              <span class="field-hint">Параллельных браузеров</span>
            </div>
          </div>
          <div class="actions-row">
            <button class="btn btn-primary btn-sm" id="btn-save-defaults">💾 Сохранить</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">🗂 Рабочая папка</div>
          <div id="settings-dir" style="font-family:monospace; font-size:12.5px; color:var(--accent); word-break:break-all;"></div>
          <div class="actions-row" style="margin-top:12px;">
            <button class="btn btn-ghost btn-sm" id="btn-open-folder3">📁 Открыть</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">🌓 Тема интерфейса</div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm theme-btn active" data-theme="dark">🌙 Тёмная</button>
            <button class="btn btn-ghost btn-sm theme-btn" data-theme="light">☀️ Светлая</button>
          </div>
        </div>
      </section>


      <!-- ========================= LOGS SCREEN ========================= -->
      <section class="screen" id="screen-logs">
        <div class="log-toolbar">
          <div class="log-filter-btns">
            <button class="log-filter-btn active" data-lvl="all">Все</button>
            <button class="log-filter-btn" data-lvl="error">Ошибки</button>
            <button class="log-filter-btn" data-lvl="warn">Предупреждения</button>
            <button class="log-filter-btn" data-lvl="ok">OK</button>
          </div>
          <span class="text-muted text-sm ml-auto" id="log-info"></span>
          <button class="btn btn-ghost btn-sm" id="btn-clear-log">🧹 Очистить</button>
          <button class="btn btn-ghost btn-sm" id="btn-copy-log">⧉ Копировать</button>
          <button class="btn btn-ghost btn-sm" id="btn-save-log">💾 Сохранить</button>
        </div>
        <div class="log-view" id="log-view">
          <span style="color:var(--muted);">— журнал пуст —</span>
        </div>
      </section>

    </div><!-- /content -->
  </main>
</div><!-- /app -->

<script>
// ============================================================
// Глобальные переменные
// ============================================================
let _currentMkt    = 'wb';       // wb | ozon | both
let _currentMode   = 'query_full'; // query_full | query_stage1 | query_stage2 | brand | ozon | unified
let _logSeen       = 0;
let _pollInterval  = null;
let _cachedSettings = {};
let _allRows       = [];
let _allHeaders    = [];
let _logFilterLvl  = 'all';
let _chartjs       = null;       // Chart.js объект после загрузки
let _charts        = {};         // храним Chart-инстансы
let _activityCtx   = null;

// ============================================================
// Утилиты
// ============================================================
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function fmtElapsed(secs) {
  secs = Math.floor(Math.max(0, secs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h) return `${h}ч ${String(m).padStart(2,'0')}м`;
  if (m) return `${m}м ${String(s).padStart(2,'0')}с`;
  return `${s}с`;
}

function toast(msg, type = 'info') {
  const c = $('#toast-container');
  const el = document.createElement('div');
  const icons = { ok: '✅', err: '❌', info: 'ℹ️' };
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-ico">${icons[type] || '💬'}</span><span>${escapeHtml(msg)}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 250);
  }, 3000);
}

// ============================================================
// pywebview ready
// ============================================================
function waitForApi() {
  return new Promise(resolve => {
    if (window.pywebview && window.pywebview.api) return resolve();
    window.addEventListener('pywebviewready', () => resolve(), { once: true });
    const t = setInterval(() => {
      if (window.pywebview && window.pywebview.api) { clearInterval(t); resolve(); }
    }, 40);
  });
}

// ============================================================
// Навигация
// ============================================================
const SCREEN_TITLES = {
  run: '🚀 Запуск', queue: '📋 Очередь',
  results: '📊 Результаты', settings: '⚙️ Настройки', logs: '📜 Логи'
};

function go(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const sc = $('#screen-' + name);
  if (sc) sc.classList.add('active');
  const nb = $(`.nav-btn[data-screen="${name}"]`);
  if (nb) nb.classList.add('active');
  $('#screen-title').textContent = SCREEN_TITLES[name] || name;
  if (name === 'results') loadResults();
  if (name === 'logs') renderLogFull();
  if (name === 'settings') fillSettings();
  if (name === 'queue') tryInitCharts();
}

$$('.nav-btn').forEach(b => b.addEventListener('click', () => go(b.dataset.screen)));

// ============================================================
// Маркетплейс и режим
// ============================================================
function setMkt(mkt) {
  _currentMkt = mkt;
  $$('#mkt-sel .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mkt === mkt));
  const wbModes = $('#wb-mode-row');
  if (mkt === 'wb') {
    wbModes.style.display = '';
    _currentMode = _currentMode === 'ozon' || _currentMode === 'unified' ? 'query_full' : _currentMode;
  } else if (mkt === 'ozon') {
    wbModes.style.display = 'none';
    _currentMode = 'ozon';
  } else { // both
    wbModes.style.display = 'none';
    _currentMode = 'unified';
  }
  setWbMode(_currentMode);
  renderForm();
}

function setWbMode(mode) {
  _currentMode = mode;
  $$('#wb-mode-row .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderForm();
}

$$('#mkt-sel .seg-btn').forEach(b => b.addEventListener('click', () => setMkt(b.dataset.mkt)));
$$('#wb-mode-row .seg-btn').forEach(b => b.addEventListener('click', () => setWbMode(b.dataset.mode)));

// ============================================================
// Определения полей формы
// ============================================================
const FORM_FIELDS = {
  query_full: [
    {key:'query',   lbl:'Поисковый запрос',    type:'text',   def:'детская обувь', hint:'Например: «детская обувь»'},
    {key:'limit',   lbl:'Лимит карточек',       type:'number', def:5000, min:1, max:200000},
    {key:'workers', lbl:'Браузер-воркеры',       type:'number', def:4, min:1, max:12, hint:'Параллельных браузеров (3–6 оптимально)'},
    {key:'expiry_warning_days', lbl:'Скоро истекает (дней)', type:'number', def:30, min:1, max:365},
    {key:'headless',        lbl:'Скрытый браузер',    type:'switch', def:true},
    {key:'make_report_xlsx',lbl:'Расширенный отчёт',   type:'switch', def:true, hint:'Листы «Сводка» + «Подробности»'},
  ],
  query_stage1: [
    {key:'query',            lbl:'Поисковый запрос',  type:'text',   def:'детская обувь'},
    {key:'limit',            lbl:'Лимит карточек',    type:'number', def:10000, min:1, max:200000},
    {key:'workers',          lbl:'HTTP-воркеры',      type:'number', def:3, min:1, max:20, hint:'×10 в команде'},
    {key:'output_links_csv', lbl:'Ссылки CSV',        type:'text',   def:'registry_links.csv'},
    {key:'output',           lbl:'Карточки XLSX',     type:'text',   def:'links.xlsx'},
  ],
  query_stage2: [
    {key:'input_links_csv',  lbl:'Входной CSV ссылок', type:'text',  def:'registry_links.csv'},
    {key:'output',           lbl:'Результат XLSX',     type:'text',  def:'result.xlsx'},
    {key:'limit',            lbl:'Лимит',              type:'number',def:10000, min:1, max:200000},
    {key:'workers',          lbl:'Браузер-воркеры',    type:'number',def:3, min:1, max:10},
    {key:'expiry_warning_days',lbl:'Скоро истекает (дней)',type:'number',def:30,min:1,max:365},
    {key:'headless',         lbl:'Скрытый браузер',   type:'switch', def:true},
    {key:'make_report_xlsx', lbl:'Расширенный отчёт', type:'switch', def:true},
    {key:'strict_brand',     lbl:'Строгий бренд',     type:'text',  def:'', hint:'Опционально'},
    {key:'strict_brand_match',lbl:'Тип совпадения',   type:'select',def:'any', options:['any','exact','contains']},
  ],
  brand: [
    {key:'brand',       lbl:'Бренд',                   type:'text',  def:'adidas', hint:'Латиницей, как на WB'},
    {key:'brand_match', lbl:'Тип совпадения',           type:'select',def:'exact',options:['exact','contains','any']},
    {key:'limit',       lbl:'Лимит карточек',           type:'number',def:5000, min:1, max:200000},
    {key:'workers',     lbl:'Браузер-воркеры',          type:'number',def:4, min:1, max:12},
    {key:'expiry_warning_days',lbl:'Скоро истекает (дней)',type:'number',def:30,min:1,max:365},
    {key:'output',      lbl:'Результат XLSX',           type:'text',  def:'brand_result.xlsx'},
    {key:'make_report_xlsx',lbl:'Расширенный отчёт',    type:'switch',def:true},
  ],
  ozon: [
    {key:'query',   lbl:'Поисковый запрос Ozon', type:'text',  def:'детская обувь', hint:'Как в поиске Ozon.ru'},
    {key:'limit',   lbl:'Лимит товаров',         type:'number',def:1000, min:1, max:50000},
    {key:'workers', lbl:'Воркеры',               type:'number',def:10, min:1, max:30, hint:'Параллельных потоков (5–15)'},
    {key:'expiry_warning_days',lbl:'Скоро истекает (дней)',type:'number',def:30,min:1,max:365},
    {key:'headless',lbl:'Скрытый браузер',       type:'switch',def:true},
    {key:'make_report_xlsx',lbl:'Расширенный отчёт',type:'switch',def:true},
    {key:'output',  lbl:'Результат XLSX',        type:'text',  def:'ozon_result.xlsx'},
    {key:'ozon_delay_min_ms',lbl:'Мин. задержка (мс)',type:'number',def:200,min:50,max:2000},
    {key:'ozon_delay_max_ms',lbl:'Макс. задержка (мс)',type:'number',def:500,min:100,max:5000},
  ],
  unified: [
    {key:'query',   lbl:'Поисковый запрос',   type:'text',  def:'детская обувь', hint:'Одновременно WB + Ozon'},
    {key:'limit',   lbl:'Лимит карточек',     type:'number',def:3000, min:1, max:100000},
    {key:'workers', lbl:'Воркеры',            type:'number',def:4, min:1, max:12},
    {key:'expiry_warning_days',lbl:'Скоро истекает (дней)',type:'number',def:30,min:1,max:365},
    {key:'headless',lbl:'Скрытый браузер',   type:'switch',def:true},
    {key:'make_report_xlsx',lbl:'Расширенный отчёт',type:'switch',def:true},
    {key:'unified_report',lbl:'Объединить отчёты WB+Ozon',type:'switch',def:true,hint:'Создать общий XLSX'},
    {key:'output',  lbl:'Результат XLSX',    type:'text',  def:'unified_result.xlsx'},
  ],
};

const MODE_LABELS = {
  query_full:   '🔍 По запросу — полный прогон',
  query_stage1: '🔗 Только сбор ссылок (Этап 1)',
  query_stage2: '📋 Только реестры из CSV (Этап 2)',
  brand:        '🏷️ По бренду WB',
  ozon:         '🛒 Ozon — поиск + реестры',
  unified:      '⚡ Unified — WB + Ozon параллельно',
};

const MKT_TAGS = {
  query_full: 'WB', query_stage1: 'WB', query_stage2: 'WB',
  brand: 'WB', ozon: 'Ozon', unified: 'WB+Ozon'
};

// ============================================================
// Рендер формы
// ============================================================
function renderForm() {
  const fields = FORM_FIELDS[_currentMode] || [];
  const saved  = _cachedSettings.last_spec || {};
  const grid   = $('#form-grid');
  grid.innerHTML = '';
  $('#form-card-title').innerHTML = `${MODE_LABELS[_currentMode] || _currentMode}
    <span class="ctag">${MKT_TAGS[_currentMode] || ''}</span>`;

  fields.forEach(f => {
    const val = (saved[f.key] !== undefined) ? saved[f.key] : f.def;
    const wrap = document.createElement('div');
    if (f.type === 'switch') {
      wrap.innerHTML = `
        <div style="padding:8px 0;">
          <label class="toggle-wrap">
            <input type="checkbox" data-key="${f.key}" ${val ? 'checked' : ''}>
            <div class="toggle-track"></div>
            <div>
              <div class="toggle-label">${escapeHtml(f.lbl)}</div>
              ${f.hint ? `<div class="toggle-sub">${escapeHtml(f.hint)}</div>` : ''}
            </div>
          </label>
        </div>`;
    } else if (f.type === 'select') {
      const opts = (f.options||[]).map(o =>
        `<option value="${o}" ${val===o?'selected':''}>${o}</option>`).join('');
      wrap.innerHTML = `
        <div class="field">
          <span class="field-label">${escapeHtml(f.lbl)}</span>
          <select data-key="${f.key}">${opts}</select>
          ${f.hint ? `<span class="field-hint">${escapeHtml(f.hint)}</span>` : ''}
        </div>`;
    } else {
      const t = f.type === 'number' ? 'number' : 'text';
      const minattr = f.min !== undefined ? `min="${f.min}"` : '';
      const maxattr = f.max !== undefined ? `max="${f.max}"` : '';
      const safeVal = String(val).replace(/"/g, '&quot;');
      wrap.innerHTML = `
        <div class="field">
          <span class="field-label">${escapeHtml(f.lbl)}</span>
          <input type="${t}" data-key="${f.key}" ${minattr} ${maxattr} value="${safeVal}">
          ${f.hint ? `<span class="field-hint">${escapeHtml(f.hint)}</span>` : ''}
        </div>`;
    }
    grid.appendChild(wrap);
  });
}

function collectSpec() {
  const spec = { mode: _currentMode };
  $$('#form-grid [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') spec[k] = el.checked;
    else if (el.type === 'number') spec[k] = Number(el.value) || 0;
    else spec[k] = el.value;
  });
  spec.use_wb_enhanced = $('#use-wb-enhanced').checked;
  spec.use_fsa_enhanced = $('#use-fsa-enhanced').checked;
  return spec;
}

// ============================================================
// Run / Stop
// ============================================================
async function startRun() {
  const spec = collectSpec();
  await window.pywebview.api.save_settings({ last_spec: spec });
  resetLiveLog();  // v27.6: сброс live-лога при новом прогоне
  const res = await window.pywebview.api.start_run(spec);
  if (!res.ok) {
    toast(res.error || 'Не удалось запустить', 'err');
    return;
  }
  toast('Прогон запущен!', 'ok');
  go('queue');
}

async function stopRun() {
  await window.pywebview.api.stop_run();
  toast('Команда «Стоп» отправлена', 'info');
}

$('#btn-run').addEventListener('click', startRun);
$('#btn-stop').addEventListener('click', stopRun);
$('#btn-diagnose').addEventListener('click', async () => {
  const d = await window.pywebview.api.diagnose();
  const eng = Object.entries(d.engines).map(([k, v]) => `  ${v ? '✓' : '✗'} ${k}`).join('\n');
  const deps = d.missing_deps.length ? 'ОТСУТСТВУЮТ: ' + d.missing_deps.join(', ') : 'все на месте';
  const msg = [
    `Версия: ${d.app_version}`,
    `Python: ${d.python_version}`,
    `Платформа: ${d.platform}`,
    `Папка: ${d.app_dir}`,
    ``,
    `Движки:`,
    eng,
    ``,
    `Зависимости: ${deps}`,
    ``,
    `Последняя команда:`,
    d.last_cmd || 'ещё не запускалась',
    ``,
    `Последняя ошибка:`,
    d.last_error || 'нет',
  ].join('\n');
  alert(msg);
});
// Баннер о недостающих зависимостях
(async () => {
  try {
    const d = await window.pywebview.api.diagnose();
    if (d.missing_deps && d.missing_deps.length) {
      const b = $('#deps-banner');
      $('#deps-banner-text').textContent =
        'не установлены пакеты: ' + d.missing_deps.join(', ') +
        ' — запустите install_windows.bat или pip install -U ' + d.missing_deps.join(' ');
      b.style.display = 'block';
    }
  } catch (e) {}
})();
$('#btn-open-folder').addEventListener('click', () => window.pywebview.api.open_workspace());
$('#btn-open-folder3').addEventListener('click', () => window.pywebview.api.open_workspace());
$('#btn-goto-results').addEventListener('click', () => go('results'));
$('#btn-view-last-results').addEventListener('click', () => go('results'));

$('#btn-open-result').addEventListener('click', async () => {
  const s = await window.pywebview.api.get_state();
  if (s.output_path) window.pywebview.api.open_path(s.output_path);
});
$('#btn-open-ozon-result').addEventListener('click', async () => {
  const s = await window.pywebview.api.get_state();
  if (s.ozon_output_path) window.pywebview.api.open_path(s.ozon_output_path);
});
$('#btn-open-log').addEventListener('click', async () => {
  const s = await window.pywebview.api.get_state();
  if (s.log_path) window.pywebview.api.open_path(s.log_path);
});
$('#btn-open-last-xlsx').addEventListener('click', async () => {
  const s = await window.pywebview.api.get_state();
  if (s.output_path) window.pywebview.api.open_path(s.output_path);
});

// ============================================================
// Polling
// ============================================================
let _errorShown = false;
async function pollOnce() {
  try {
    const s = await window.pywebview.api.get_state();
    updateStatusBar(s);
    updateQueueScreen(s);
    streamLog(s);
    // Автопереход на «Логи» при ошибке
    if (s.error && !_errorShown) {
      _errorShown = true;
      toast('Ошибка прогона — открываю логи', 'err');
      setTimeout(() => go('logs'), 600);
    }
    if (!s.error && !s.running) _errorShown = false;
  } catch (e) { /* pywebview ещё не готов */ }
}

function updateStatusBar(s) {
  const dot = $('#status-dot');
  const txt = $('#status-text');
  if (s.running) {
    dot.className = 'status-dot running';
    txt.textContent = s.stage_label || 'выполняется…';
  } else if (s.error) {
    dot.className = 'status-dot error';
    txt.textContent = 'ошибка';
  } else if (s.output_path) {
    dot.className = 'status-dot ok';
    txt.textContent = 'готово';
  } else {
    dot.className = 'status-dot';
    txt.textContent = 'готов';
  }
  $('#btn-run').disabled  = !!s.running;
  $('#btn-stop').disabled = !s.running;
  $('#queue-badge').classList.toggle('visible', !!s.running);

  // Last run card
  if (s.output_path && !s.running) {
    $('#last-run-card').style.display = '';
    const fname = s.output_path.split(/[\/\\]/).pop();
    $('#last-run-info').innerHTML = `
      <span class="badge badge-ok">✓ готово</span>
      <span style="margin-left:8px; color:var(--accent); font-family:monospace;">${escapeHtml(fname)}</span>
      <span class="text-muted" style="margin-left:8px; font-size:12px;">
        ${fmtElapsed(s.elapsed_sec)}
      </span>`;
  }
}

// v27.6: Пуллинг live-лога. Держим последние ~30 строк stdout.
let _liveLogOffset = 0;
let _liveLogLines = [];
let _liveLogBusy = false;
async function refreshLiveLog(state) {
  try {
    if (!state || !state.running) {
      // Прогон завершён — всё равно дотягиваем остаток один раз
      if (_liveLogOffset >= (state.log_total || 0)) return;
    }
    if (_liveLogBusy) return;
    _liveLogBusy = true;
    const data = await window.pywebview.api.get_log_lines(_liveLogOffset);
    if (data && data.lines && data.lines.length) {
      _liveLogOffset += data.lines.length;
      _liveLogLines = _liveLogLines.concat(data.lines).slice(-30);
      const box = $('#livelog-box');
      if (box) {
        const html = _liveLogLines.map(l => colorLogLine(l)).join('\n');
        box.innerHTML = html;
        box.scrollTop = box.scrollHeight;
      }
      const lblTotal = $('#livelog-total');
      if (lblTotal) lblTotal.textContent = data.total + ' строк';
    }
  } catch(e) {
    // тихо
  } finally {
    _liveLogBusy = false;
  }
}
function colorLogLine(line) {
  const s = escapeHtml(line);
  if (/\[ОШИБКА\]|\[ERROR\]|\bERROR\b|exception|traceback/i.test(line))
    return '<span style="color:#ff6b6b">' + s + '</span>';
  if (/\[ТАЙМАУТ\]|\[WARN\]|warning/i.test(line))
    return '<span style="color:#ffd166">' + s + '</span>';
  if (/\[OK\]|\u2713|готово|success/i.test(line))
    return '<span style="color:#7ce087">' + s + '</span>';
  if (/\[Ozon\]|\[Ozon-Playwright\]/i.test(line))
    return '<span style="color:#4cc9f0">' + s + '</span>';
  if (/^━━━|━━━ /.test(line))
    return '<span style="color:#a78bfa; font-weight:600">' + s + '</span>';
  return s;
}
function resetLiveLog() {
  _liveLogOffset = 0;
  _liveLogLines = [];
  const box = $('#livelog-box');
  if (box) box.innerHTML = 'Ожидание запуска…';
}

function updateQueueScreen(s) {
  const pct = s.progress_pct || 0;
  $('#prog-bar').style.width = pct.toFixed(1) + '%';
  $('#kpi-pct').textContent  = pct.toFixed(0) + '%';
  $('#kpi-pct-sub').textContent = s.progress_total
    ? `${s.progress_done} из ${s.progress_total}` : '— из —';
  $('#kpi-elapsed').textContent = fmtElapsed(s.elapsed_sec || 0);
  $('#kpi-mode-lbl').textContent = s.mode || '—';
  $('#kpi-speed').textContent = s.speed_per_min > 0 ? s.speed_per_min.toFixed(1) : '—';
  $('#prog-label').textContent = s.running ? 'выполняется' : (s.output_path ? 'завершено' : 'ожидание');
  const STAGE_LABELS = {
    links: 'этап: сбор ссылок на документы',
    registry: 'этап: проверка реестров',
    search: 'этап: поиск карточек',
    cards: 'этап: загрузка карточек',
  };
  $('#prog-stage').textContent = s.stage_label || STAGE_LABELS[s.progress_stage] || '';

  const st  = (s.metrics && s.metrics.status)      || {};
  const reg = (s.metrics && s.metrics.registry)     || {};
  const mkt = (s.metrics && s.metrics.marketplace)  || {};

  let okCnt = 0, errCnt = 0;
  Object.entries(st).forEach(([k,v]) => {
    if (k==='OK' || k.includes('СОБРАНА')) okCnt += v;
    else if (k==='ОШИБКА' || k==='ТАЙМАУТ' || k==='НЕСООТВЕТСТВИЕ') errCnt += v;
  });
  $('#kpi-errors').textContent = errCnt;
  $('#kpi-ok-sub').textContent = `OK: ${okCnt}`;

  $('#btn-open-result').disabled      = !s.output_path;
  $('#btn-open-ozon-result').disabled = !s.ozon_output_path;
  $('#btn-open-log').disabled         = !s.log_path;

  // v27.6: Live-лог
  refreshLiveLog(s);

  // Стек-бар статусов
  renderStatusStack(st);

  // Сброс кэша при новом запуске
  if (s.running && _queueChartsLoaded) _queueChartsLoaded = false;

  // Пока идёт прогон — показываем лайв-статистику из metrics (stdout-парсер движка)
  // После завершения — подгружаем из xlsx полную статистику.
  if (_chartjs) {
    if (s.running) {
      updateDonutChart('chart-status',      'chart-status-fb',      st,  STATUS_COLORS);
      updateDonutChart('chart-registry',    'chart-registry-fb',    reg, REGISTRY_COLORS);
      updateDonutChart('chart-marketplace', 'chart-marketplace-fb', mkt, MKT_COLORS);
      // Оригинальность лайв не можем — она в xlsx
      updateDonutChart('chart-original', 'chart-original-fb', {}, ORIGINAL_COLORS);
    } else if (s.output_path && !_queueChartsLoaded) {
      _queueChartsLoaded = true;
      refreshQueueCharts();
    }
  }
}
let _queueChartsLoaded = false;

function renderStatusStack(stat) {
  const stack = $('#status-stack');
  const leg = $('#status-stack-legend');
  if (!stack || !leg) return;
  const entries = Object.entries(stat).filter(([k, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!total) { stack.innerHTML = ''; leg.innerHTML = ''; return; }
  stack.innerHTML = entries.map(([k, v], i) => {
    const w = (v / total * 100).toFixed(2);
    const c = STATUS_COLORS[k] || colorFor(i, entries.length);
    return `<div title="${escapeHtml(k)}: ${v}" style="width:${w}%; background:${c};"></div>`;
  }).join('');
  leg.innerHTML = entries.map(([k, v], i) => {
    const c = STATUS_COLORS[k] || colorFor(i, entries.length);
    return `<span style="display:inline-flex; align-items:center; gap:6px;">
      <span style="width:10px; height:10px; border-radius:2px; background:${c};"></span>
      ${escapeHtml(k)} — <strong style="color:var(--fg);">${v}</strong>
    </span>`;
  }).join('');
}

// ============================================================
// Log streaming
// ============================================================
async function streamLog(s) {
  if (s.log_total > _logSeen) {
    const chunk = await window.pywebview.api.get_log_lines(_logSeen);
    _logSeen = chunk.from + chunk.lines.length;
    appendLogLines(chunk.lines);
  }
}

function classifyLine(ln) {
  if (ln.startsWith('━━━'))            return 'log-line-head';
  if (ln.startsWith('[команда]'))       return 'log-line-cmd';
  if (ln.startsWith('[ОШИБКА') || ln.includes('[ERROR]') || ln.includes('ERROR')) return 'log-line-err';
  if (ln.includes('[OK]') || ln.includes('[OK ') || ln.startsWith('[OK]')) return 'log-line-ok';
  if (ln.includes('[ТАЙМАУТ]') || ln.includes('[ОШИБКА]') || ln.includes('ОШИБК')) return 'log-line-err';
  if (ln.includes('WARN') || ln.includes('ПРЕДУПРЕЖ')) return 'log-line-warn';
  if (ln.startsWith('[завершено') || ln.startsWith('[команда')) return 'log-line-cmd';
  return 'log-line-info';
}

function passesFilter(cls) {
  if (_logFilterLvl === 'all') return true;
  if (_logFilterLvl === 'error') return cls === 'log-line-err';
  if (_logFilterLvl === 'warn')  return cls === 'log-line-warn';
  if (_logFilterLvl === 'ok')    return cls === 'log-line-ok';
  return true;
}

function appendLogLines(lines) {
  const el = $('#log-view');
  if (el.children.length === 1 && el.querySelector('span')) el.innerHTML = '';
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  const frag = document.createDocumentFragment();
  for (const ln of lines) {
    const cls = classifyLine(ln);
    if (!passesFilter(cls)) continue;
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = ln;
    frag.appendChild(div);
  }
  el.appendChild(frag);
  if (atBottom) el.scrollTop = el.scrollHeight;
  $('#log-info').textContent = `${_logSeen} строк`;
}

function renderLogFull() {
  $('#log-info').textContent = `${_logSeen} строк`;
}

$$('.log-filter-btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('.log-filter-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _logFilterLvl = b.dataset.lvl;
    rebuildLog();
  });
});

function rebuildLog() {
  // Перефильтровываем уже загруженные строки
  const el = $('#log-view');
  const existing = Array.from(el.children);
  existing.forEach(div => {
    if (!div.className) return;
    div.style.display = passesFilter(div.className) ? '' : 'none';
  });
}

$('#btn-clear-log').addEventListener('click', () => {
  $('#log-view').innerHTML = '<span style="color:var(--muted);">— журнал очищен —</span>';
  _logSeen = 0;
});
$('#btn-copy-log').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#log-view').innerText); toast('Лог скопирован', 'ok'); }
  catch (e) { toast('Не удалось скопировать', 'err'); }
});
$('#btn-save-log').addEventListener('click', async () => {
  const res = await window.pywebview.api.export_csv(null, '');
  // Лог отдельно не экспортируется — открываем log_path если есть
  const s = await window.pywebview.api.get_state();
  if (s.log_path) { window.pywebview.api.open_path(s.log_path); }
  else toast('Лог-файл не найден', 'info');
});

// ============================================================
// Results table
// ============================================================
async function loadResults() {
  const wrap = $('#tbl-wrap');
  wrap.innerHTML = '<div class="empty-state"><div class="empty-ico">⏳</div><p>Загрузка…</p></div>';
  const res = await window.pywebview.api.get_results();
  if (!res.ok) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-ico">📋</div><p>${escapeHtml(res.error)}</p></div>`;
    return;
  }
  _allHeaders = res.columns;
  _allRows    = res.rows;
  $('#results-count').textContent = `${res.total} строк · «${res.sheet}»`;

  // Fill status filter
  const statSel = $('#filter-status');
  const statuses = Object.keys(res.stats.by_status || {});
  statSel.innerHTML = '<option value="">Все статусы</option>' +
    statuses.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  renderTable(_allRows);

  // Charts
  if (_chartjs) {
    buildResultsCharts(res.stats);
  }
}

function renderTable(rows) {
  const wrap = $('#tbl-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-ico">🤷</div><p>Ничего не найдено</p></div>';
    return;
  }
  // Показываем первые 14 колонок
  const cols = _allHeaders.slice(0, 14);
  let html = '<table><thead><tr>' +
    cols.map(h => `<th title="${escapeHtml(h)}">${escapeHtml(h.length > 22 ? h.slice(0,20)+'…' : h)}</th>`).join('') +
    '</tr></thead><tbody>';
  const hl = _allHeaders.map(x => x.toLowerCase());
  for (const row of rows.slice(0, 1000)) {
    html += '<tr>';
    cols.forEach((_, ci) => {
      const v = String(row[ci] ?? '');
      const head = hl[ci] || '';
      let badge = '';
      if (head.includes('риск')) {
        if (v === 'Действует')         badge = 'badge-ok';
        else if (v === 'Скоро истекает') badge = 'badge-warn';
        else if (v === 'Истёк')          badge = 'badge-error';
        else if (v)                      badge = 'badge-muted';
      } else if (head.includes('статус') || head.includes('status')) {
        if (v.includes('OK') || v.includes('СОБРАНА')) badge = 'badge-ok';
        else if (v.includes('ОШИБКА') || v.includes('ТАЙМАУТ')) badge = 'badge-error';
        else if (v.includes('ПРОВЕРИТЬ') || v.includes('НЕ УДАЛОСЬ')) badge = 'badge-warn';
        else if (v) badge = 'badge-muted';
      } else if (head.includes('маркетплейс') || head.includes('marketplace')) {
        if (v === 'WB' || v.toLowerCase().includes('wildberries')) badge = 'badge-wb';
        else if (v.toLowerCase().includes('ozon')) badge = 'badge-ozon';
      }
      html += badge
        ? `<td><span class="badge ${badge}">${escapeHtml(v)}</span></td>`
        : `<td title="${escapeHtml(v)}">${escapeHtml(v)}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

$('#filter-input').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  const st = $('#filter-status').value.toLowerCase();
  applyTableFilter(q, st);
});
$('#filter-status').addEventListener('change', e => {
  const q = $('#filter-input').value.toLowerCase().trim();
  applyTableFilter(q, e.target.value.toLowerCase());
});

function applyTableFilter(q, st) {
  let rows = _allRows;
  if (q) rows = rows.filter(r => r.some(c => String(c).toLowerCase().includes(q)));
  if (st) {
    const hl = _allHeaders.map(x => x.toLowerCase());
    const si = hl.findIndex(h => h.includes('статус') || h.includes('status'));
    if (si >= 0) rows = rows.filter(r => String(r[si]).toLowerCase().includes(st));
  }
  renderTable(rows);
  $('#results-count').textContent = `${rows.length} строк (фильтр)`;
}

$('#btn-reload-results').addEventListener('click', loadResults);
$('#btn-export-csv').addEventListener('click', async () => {
  const q = $('#filter-input').value.trim();
  const res = await window.pywebview.api.export_csv(null, q);
  if (res.ok) toast(`CSV сохранён: ${res.rows} строк`, 'ok');
  else toast(res.error || 'Ошибка экспорта', 'err');
});

// ============================================================
// Settings screen
// ============================================================
async function fillSettings() {
  const v = await window.pywebview.api.get_version();

  $('#settings-version-info').innerHTML = `
    <div>Версия: <b>${escapeHtml(v.app_version)}</b></div>
    <div>Python ${escapeHtml(v.python)} · ${escapeHtml(v.platform)}</div>
    <div style="margin-top:4px; color:var(--muted); font-family:monospace; font-size:12px;">${escapeHtml(v.app_dir)}</div>`;

  $('#settings-dir').textContent = v.app_dir;

  // Engine statuses
  const engines = [
    {label:'main_v39.py (WB Query)',  exists: v.engine_v39_exists,  path: v.engine_v39},
    {label:'main_brand.py (WB Brand)',exists: v.engine_brand_exists, path: v.engine_brand},
    {label:'ozon_parser.py (Ozon)',   exists: v.engine_ozon_exists,  path: v.engine_ozon},
    {label:'wb_enhanced.py',          exists: v.engine_wb_enhanced_exists},
    {label:'fsa_enhanced.py',         exists: v.engine_fsa_enhanced_exists},
  ];
  $('#settings-engines').innerHTML = engines.map(e => `
    <div class="engine-status">
      <span class="engine-dot ${e.exists ? 'ok' : 'miss'}"></span>
      <span style="font-family:monospace; font-size:12.5px; flex:1;">${escapeHtml(e.label)}</span>
      <span class="badge ${e.exists ? 'badge-ok' : 'badge-error'}">${e.exists ? 'найден' : 'отсутствует'}</span>
    </div>`).join('');

  // Sidebar footer
  $('#foot-py').textContent = `Python ${v.python} · ${v.platform}`;
  $('#foot-dir').textContent = v.app_dir;
  const footEl = $('#foot-engines');
  footEl.innerHTML = engines.slice(0,3).map(e => `
    <div>
      <span class="engine-dot ${e.exists?'ok':'miss'}"></span>
      <span style="font-size:10.5px;">${escapeHtml(e.label.split(' ')[0])}</span>
    </div>`).join('');

  // Load saved defaults
  const s = await window.pywebview.api.get_settings();
  if (s.defaults) {
    if (s.defaults.expiry_warning_days) $('#s-expiry').value = s.defaults.expiry_warning_days;
    if (s.defaults.workers) $('#s-workers').value = s.defaults.workers;
  }
}

$('#btn-save-defaults').addEventListener('click', async () => {
  const data = {
    defaults: {
      expiry_warning_days: parseInt($('#s-expiry').value) || 30,
      workers: parseInt($('#s-workers').value) || 4,
    }
  };
  const res = await window.pywebview.api.save_settings(data);
  toast(res.ok ? 'Настройки сохранены' : 'Ошибка сохранения', res.ok ? 'ok' : 'err');
});

// Theme toggle
$$('.theme-btn').forEach(b => {
  b.addEventListener('click', () => {
    const th = b.dataset.theme;
    document.documentElement.setAttribute('data-theme', th === 'light' ? 'light' : '');
    $$('.theme-btn').forEach(x => x.classList.toggle('active', x.dataset.theme === th));
    window.pywebview.api.save_settings({ theme: th });
  });
});

// ============================================================
// Chart.js integration
// ============================================================
const STATUS_COLORS = {
  'OK':                                    '#10b981',
  'ССЫЛКА НА РЕЕСТР СОБРАНА':           '#34d399',
  'НЕДЕЙСТВУЮЩИЙ ДОКУМЕНТ':                 '#fbbf24',
  'НЕСООТВЕТСТВИЕ':                        '#fb923c',
  'НЕ УДАЛОСЬ ИЗВЛЕЧЬ НАЗВАНИЕ ИЗ РЕЕСТРА': '#a78bfa',
  'ОШИБКА':                                '#ef4444',
  'ТАЙМАУТ':                               '#f87171',
  'НЕТ ДОКУМЕНТОВ':                        '#6b7280',
  'НЕТ ССЫЛКИ НА РЕЕСТР':                 '#94a3b8',
};
const MKT_COLORS = {
  'WB': '#cb11ab', 'Wildberries': '#cb11ab', 'wildberries': '#cb11ab',
  'Ozon': '#005bff', 'OZON': '#005bff', 'ozon': '#005bff',
  'Не определен': '#6b7280',
};
const REGISTRY_COLORS = {
  'pub.fsa.gov.ru':      '#5b8cff',
  'swis.trade.kg':       '#10b981',
  'belgiss.by':          '#a78bfa',
  'tsouz.belgiss.by':    '#8b5cf6',
  'portal.eaeunion.org': '#fb923c',
};
const ORIGINAL_COLORS = {
  'Оригинал':     '#10b981',
  'Не оригинал': '#ef4444',
  'Не указано':  '#6b7280',
};
const RISK_COLORS = {
  'Действует':          '#10b981',
  'Скоро истекает':     '#fbbf24',
  'Истёк':              '#ef4444',
  'Срок не известен': '#6b7280',
};

// 24-цветная палитра без повторов, подобранная по оттенкам
const PALETTE = [
  '#5b8cff','#10b981','#a78bfa','#fb923c','#f87171','#38bdf8',
  '#fbbf24','#34d399','#ec4899','#8b5cf6','#06b6d4','#84cc16',
  '#f59e0b','#14b8a6','#d946ef','#0ea5e9','#22c55e','#eab308',
  '#f43f5e','#6366f1','#10b981','#f97316','#a855f7','#3b82f6',
];

function colorFor(i, total) {
  // Равномерно распределяем цвета по палитре, чтобы соседние не сливались
  if (total <= 0) return PALETTE[0];
  const step = Math.max(1, Math.floor(PALETTE.length / Math.min(total, PALETTE.length)));
  return PALETTE[(i * step) % PALETTE.length];
}

function randomColor(i) { return colorFor(i, 8); }

function tryInitCharts() {
  if (_chartjs || !window.Chart) return;
  _chartjs = window.Chart;
  // Глобальные настройки Chart.js
  _chartjs.defaults.color = '#6b6e82';
  _chartjs.defaults.borderColor = 'rgba(255,255,255,0.06)';
  _chartjs.defaults.font.family = "-apple-system, 'Segoe UI', Roboto, sans-serif";
  _chartjs.defaults.plugins.legend.labels.boxWidth = 12;
  _chartjs.defaults.plugins.legend.labels.padding  = 14;
}

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

function _truncateLabel(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function updateDonutChart(canvasId, fallbackId, data, colorMap, opts) {
  tryInitCharts();
  opts = opts || {};
  const canvas = $('#' + canvasId);
  const fb = fallbackId ? $('#' + fallbackId) : null;
  if (!canvas) return;
  // Сортируем по убыванию
  let entries = Object.entries(data).filter(([k, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    if (fb) { fb.style.display = ''; canvas.style.display = 'none'; }
    destroyChart(canvasId);
    return;
  }
  if (fb) { fb.style.display = 'none'; canvas.style.display = ''; }
  const fullLabels = entries.map(([k]) => k);
  const labels = fullLabels.map(k => _truncateLabel(k, opts.maxLabel || 28));
  const values = entries.map(([, v]) => v);
  const colors = fullLabels.map((k, i) =>
    (colorMap && colorMap[k]) || colorFor(i, fullLabels.length));

  const cfg = {
    type: opts.type || 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: opts.type === 'bar' ? 0 : 2,
        borderColor: '#1e1f29',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: opts.type === 'bar' ? undefined : '62%',
      indexAxis: opts.type === 'bar' ? 'y' : undefined,
      plugins: {
        legend: {
          display: opts.type !== 'bar',
          position: 'right',
          labels: { font: { size: 11 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            title: (items) => fullLabels[items[0].dataIndex] || '',
            label: ctx => {
              const total = values.reduce((a, b) => a + b, 0) || 1;
              const pct = ((ctx.parsed.x ?? ctx.parsed.y ?? ctx.parsed) / total * 100).toFixed(1);
              return ` ${ctx.parsed.x ?? ctx.parsed.y ?? ctx.parsed} (${pct}%)`;
            },
          },
        },
      },
      scales: opts.type === 'bar' ? {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9aa0b4' } },
        y: { grid: { display: false }, ticks: { color: '#d4d6e0', font: { size: 11 } } },
      } : undefined,
    },
  };
  if (_charts[canvasId]) { destroyChart(canvasId); }
  if (!_chartjs) return;
  _charts[canvasId] = new _chartjs(canvas, cfg);
}

function buildResultsCharts(stats) {
  tryInitCharts();
  if (!_chartjs) return;
  updateDonutChart('res-chart-status',      'res-chart-status-fb',      stats.by_status      || {}, STATUS_COLORS);
  updateDonutChart('res-chart-registry',    'res-chart-registry-fb',    stats.by_registry    || {}, REGISTRY_COLORS);
  updateDonutChart('res-chart-marketplace', 'res-chart-marketplace-fb', stats.by_marketplace || {}, MKT_COLORS);
  updateDonutChart('res-chart-original',    'res-chart-original-fb',    stats.by_original    || {}, ORIGINAL_COLORS);
  updateDonutChart('res-chart-risk',        'res-chart-risk-fb',        stats.by_risk        || {}, RISK_COLORS);
  updateDonutChart('res-chart-brand',       'res-chart-brand-fb',       stats.by_brand       || {}, null, { type: 'bar', maxLabel: 24 });
}

// Кэш последней статистики для вкладки «Очередь»
let _lastQueueStats = null;
async function refreshQueueCharts() {
  // Гружаем статистику из файла-результата (если он есть)
  try {
    const res = await window.pywebview.api.get_results(null, 5000);
    if (res && res.ok && res.stats) {
      _lastQueueStats = res.stats;
    } else {
      _lastQueueStats = null;
    }
  } catch (e) { _lastQueueStats = null; }
  const st = _lastQueueStats || { by_status: {}, by_registry: {}, by_marketplace: {}, by_original: {} };
  updateDonutChart('chart-status',      'chart-status-fb',      st.by_status      || {}, STATUS_COLORS);
  updateDonutChart('chart-registry',    'chart-registry-fb',    st.by_registry    || {}, REGISTRY_COLORS);
  updateDonutChart('chart-marketplace', 'chart-marketplace-fb', st.by_marketplace || {}, MKT_COLORS);
  updateDonutChart('chart-original',    'chart-original-fb',    st.by_original    || {}, ORIGINAL_COLORS);
}

// Activity sparkline (mini canvas)
function drawSparkline(series) {
  const canvas = $('#activity-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  canvas.width  = wrap.offsetWidth  || 400;
  canvas.height = wrap.offsetHeight || 80;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!series.length) return;
  const max = Math.max(...series, 1);
  const w = canvas.width;
  const h = canvas.height;
  const step = w / Math.max(series.length - 1, 1);

  // Fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(91,140,255,0.25)');
  grad.addColorStop(1, 'rgba(91,140,255,0)');
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo((series.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#5b8cff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Загрузка Chart.js. v27.7: библиотека встроена локально (offline) через
// _build_frontend_html на стороне Python — поэтому window.Chart обычно уже
// доступен сразу. CDN остаётся лишь аварийным fallback'ом, если локальный
// файл vendor/chart.umd.min.js по какой-то причине не встроился.
function loadChartJs() {
  return new Promise((resolve, reject) => {
    if (window.Chart) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ============================================================
// Init
// ============================================================
(async function init() {
  await waitForApi();

  _cachedSettings = await window.pywebview.api.get_settings();
  renderForm();

  // Восстановить тему
  if (_cachedSettings.theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    $$('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === 'light'));
  }

  await fillSettings();

  // Восстановить последний режим/маркет
  const last = _cachedSettings.last_spec || {};
  if (last.mode) {
    if (last.mode === 'ozon') { setMkt('ozon'); }
    else if (last.mode === 'unified') { setMkt('both'); }
    else { setMkt('wb'); setWbMode(last.mode); }
  }

  // Начальный опрос
  await pollOnce();

  // Загружаем Chart.js в фоне — не блокируем UI
  loadChartJs().then(() => {
    tryInitCharts();
  }).catch(() => {
    // Без интернета — charts работать не будут, показываем fallback
  });

  // Polling каждые 600 мс
  _pollInterval = setInterval(pollOnce, 600);
})();
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Проверка движков при запуске
# ---------------------------------------------------------------------------

def check_engines() -> None:
    """Печатает в stderr статус наличия каждого движка."""
    engines = [
        (ENGINE_V39,         "WB Query   (main_v39.py)"),
        (ENGINE_BRAND,       "WB Brand   (main_brand.py)"),
        (ENGINE_OZON,        "Ozon       (ozon_parser.py)"),
        (ENGINE_WB_ENHANCED, "WBEnhanced (wb_enhanced.py)"),
        (ENGINE_FSA_ENHANCED,"FSAEnhanced(fsa_enhanced.py)"),
    ]
    log.info("=" * 60)
    log.info("WB+Ozon Checker v27 — проверка движков")
    log.info("  Рабочая папка: %s", APP_DIR)
    for path, label in engines:
        status = "OK" if path.exists() else "ОТСУТСТВУЕТ"
        log.info("  [%s] %s", status.ljust(10), label)
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------

def check_python_deps() -> List[str]:
    """Проверяет наличие критичных Python-зависимостей. Возвращает список отсутствующих."""
    missing: List[str] = []
    for mod, pkg in [
        ("webview", "pywebview"),
        ("openpyxl", "openpyxl"),
        ("aiohttp", "aiohttp"),
        ("bs4", "beautifulsoup4"),
        ("lxml", "lxml"),
        ("curl_cffi", "curl_cffi"),
        ("playwright", "playwright"),
    ]:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    return missing


def _build_frontend_html() -> str:
    """
    Возвращает HTML интерфейса со ВСТРОЕННОЙ библиотекой Chart.js (offline).

    v27.7: раньше Chart.js грузился с интернет-CDN (cdn.jsdelivr.net) — без
    сети графики молча не рисовались (главная причина жалоб на интерфейс).
    Теперь локальный vendor/chart.umd.min.js инлайнится прямо в HTML, и графики
    работают полностью офлайн. Если файла нет — остаётся CDN-fallback в JS.
    """
    html = FRONTEND_HTML
    try:
        chart_path = APP_DIR / "vendor" / "chart.umd.min.js"
        if chart_path.exists():
            js = chart_path.read_text(encoding="utf-8")
            # Закрывающий </script> внутри библиотеки маловероятен, но на всякий
            # случай экранируем, чтобы не разорвать наш inline-блок.
            js = js.replace("</script>", "<\\/script>")
            inline = "<script>\n" + js + "\n</script>"
            html = html.replace("<!--__CHARTJS_INLINE__-->", inline, 1)
            log.info("Chart.js встроен локально (%d КБ) — графики работают офлайн", len(js) // 1024)
        else:
            log.warning("vendor/chart.umd.min.js не найден — графики будут грузиться с CDN (нужен интернет)")
    except Exception as e:
        log.warning("Не удалось встроить Chart.js локально: %s — fallback на CDN", e)
    return html


def main() -> None:
    """Запускает приложение WB+Ozon Checker v27."""
    check_engines()
    missing = check_python_deps()
    if missing:
        log.warning("=" * 60)
        log.warning("ОТСУТСТВУЮТ ПАКЕТЫ: %s", ", ".join(missing))
        log.warning("Запустите: pip install -U %s", " ".join(missing))
        log.warning("Или дважды кликните install_windows.bat")
        log.warning("=" * 60)
    bridge = Bridge()
    bridge._missing_deps = missing
    window = webview.create_window(
        title="WB+Ozon Checker v27",
        html=_build_frontend_html(),
        js_api=bridge,
        width=1400,
        height=900,
        min_size=(1100, 720),
        background_color="#0a0a0f",
    )
    webview.start(debug=False)


if __name__ == "__main__":
    main()
