#!/usr/bin/env python3
"""
Проверка целостности фронтенда окна (wb_checker.py / FRONTEND_HTML).

Окно — это встроенный HTML/CSS/JS. Самый частый способ его случайно сломать —
синтаксическая ошибка в JS: тогда не работает ВЕСЬ интерфейс. Этот скрипт:
  * вытаскивает <style> и <script> из FRONTEND_HTML;
  * проверяет баланс <style>/<script> и фигурных скобок CSS;
  * если установлен node — гоняет `node --check` по JS (точная проверка синтаксиса).

Используется как защита от регрессий при правках интерфейса.

Запуск:  python3 tests/check_frontend.py
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = (ROOT / "wb_checker.py").read_text(encoding="utf-8")

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


# Вырезаем тело шаблона FRONTEND_HTML
m = re.search(r'FRONTEND_HTML\s*=\s*r"""(.*?)"""', SRC, re.DOTALL)
check("FRONTEND_HTML найден", bool(m))
html = m.group(1) if m else ""

# Баланс тегов
check("<style>/</style> сбалансированы",
      html.count("<style>") == html.count("</style>") == 1,
      f"{html.count('<style>')}/{html.count('</style>')}")
check("<script>/</script> сбалансированы",
      html.count("<script>") == html.count("</script>") >= 1,
      f"{html.count('<script>')}/{html.count('</script>')}")

# CSS: баланс фигурных скобок
style_m = re.search(r"<style>(.*?)</style>", html, re.DOTALL)
css = style_m.group(1) if style_m else ""
check("CSS: фигурные скобки сбалансированы",
      css.count("{") == css.count("}"), f"{{={css.count('{')} }}={css.count('}')}")

# JS: node --check (если node доступен)
script_m = re.search(r"<script>\n(.*?)\n</script>", html, re.DOTALL)
js = script_m.group(1) if script_m else ""
check("JS-блок извлечён", len(js) > 1000, f"{len(js)} байт")

node = shutil.which("node")
if node:
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(js)
        js_path = f.name
    rc = subprocess.run([node, "--check", js_path], capture_output=True, text=True)
    ok = rc.returncode == 0
    check("JS: node --check без ошибок", ok, (rc.stderr or "").strip()[:200])
    Path(js_path).unlink(missing_ok=True)
else:
    print("SKIP  node не найден — пропускаю строгую проверку JS-синтаксиса")

if __name__ == "__main__":
    passed = sum(RESULTS)
    total = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
