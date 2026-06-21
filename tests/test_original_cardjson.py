"""
Офлайн-тест быстрого определения «Оригинал» через статический card.json.

По HAR живой карточки WB страница тянет card.json из той же basket-CDN, что и
certificate.json (путь /info/ru/card.json) — статический файл, берётся быстро по
HTTP без браузера/токена. Здесь проверяем генерацию URL (тот же basket-шард) и
сканер признака оригинальности.

Запуск:  python3 tests/test_original_cardjson.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


import re as _re

# 1) URL генерируются в той же basket-CDN, путь /info/ru/card.json
urls = m.card_json_urls(863239425, max_hosts=16)  # пример из HAR (basket-38)
baskets = [int(_re.search(r"basket-(\d+)", u).group(1)) for u in urls]
check("путь /info/ru/card.json", urls[0].endswith("/info/ru/card.json"), urls[0])
check("vol/part корректны (vol8632/part863239)",
      "/vol8632/part863239/863239425/" in urls[0], urls[0])
check("реальный basket-38 среди кандидатов", 38 in baskets, str(baskets))

# 2) Сканер признака «Оригинал»
check("текст 'Оригинальный товар' -> True",
      m.card_json_has_original({"badge": {"tooltip": "Оригинальный товар"}}))
check("булев isOriginal=true -> True",
      m.card_json_has_original({"options": {"isOriginal": True}}))
check("hasOriginalMark=1 в списке -> True",
      m.card_json_has_original({"a": [{"hasOriginalMark": 1}]}))
check("обычная карточка -> False",
      m.card_json_has_original({"name": "Кроссовки", "description": "хороший товар"}) is False)


# 3) fetch_original_via_card_json: при 200 с признаком возвращает True;
#    при отсутствии card.json (всё 404) — None (не знаем, не перетираем).
class _Resp:
    def __init__(self, status, body=""):
        self.status = status
        self._b = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def text(self, errors="replace"):
        return self._b


class _Sess:
    def __init__(self, routes=None, default=(404, "")):
        self.routes = routes or {}
        self.default = default

    def get(self, url, headers=None, timeout=None):
        for k, v in self.routes.items():
            if k in url:
                return _Resp(*v)
        return _Resp(*self.default)


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)

orig, det = _run(m.fetch_original_via_card_json(
    _Sess(routes={"basket-38": (200, '{"options":{"isOriginal":true}}')}),
    863239425, timeout_sec=2.0, max_hosts=16, concurrency=16))
check("card.json с признаком -> is_original True", orig is True, f"{orig} {det}")

orig2, det2 = _run(m.fetch_original_via_card_json(
    _Sess(default=(404, "")), 863239425, timeout_sec=2.0, max_hosts=8, concurrency=8))
check("нет card.json (404) -> None (не знаем)", orig2 is None, f"{orig2} {det2}")

if __name__ == "__main__":
    p = sum(RESULTS)
    t = len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
