"""
Офлайн-тесты HTTP-сбора ссылок на реестр через WB certificate.json.

Проверяем БЕЗ доступа к сети (через FakeSession):
  * шардировку basket по vol (включая новые шарды > 30 для высоких nm_id);
  * генерацию списка кандидатов certificate_json_urls;
  * КОНКУРЕНТНОСТЬ перебора (карточка без документа = ~один таймаут, а не сумма);
  * корректную классификацию исхода (ok / no_docs / neterror / has_doc_no_url).

Запуск:  python3 tests/test_cert_fetch.py
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main_v39 as m  # noqa: E402

FSA_URL = "https://pub.fsa.gov.ru/rss/certificate/view/1234567/baseInfo"


class FakeResp:
    """Имитация ответа aiohttp: async-контекст с .status и .text()."""

    def __init__(self, status, body="", delay=0.0, raise_timeout=False):
        self.status = status
        self._body = body
        self._delay = delay
        self._raise_timeout = raise_timeout

    async def __aenter__(self):
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raise_timeout == "dns":
            raise Exception("Cannot connect to host: getaddrinfo failed")
        if self._raise_timeout:
            raise asyncio.TimeoutError()
        return self

    async def __aexit__(self, *a):
        return False

    async def text(self, errors="replace"):
        return self._body


class FakeSession:
    """Маршрутизирует URL по подстроке host -> (status, body, delay[, timeout])."""

    def __init__(self, routes=None, default=(404, "", 0.0)):
        self.routes = routes or {}
        self.default = default
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        spec = self.default
        for key, val in self.routes.items():
            if key in url:
                spec = val
                break
        status = spec[0]
        body = spec[1] if len(spec) > 1 else ""
        delay = spec[2] if len(spec) > 2 else 0.0
        raise_timeout = spec[3] if len(spec) > 3 else False
        return FakeResp(status, body, delay, raise_timeout)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# --------------------------------------------------------------------------
RESULTS = []


def check(name, cond, extra=""):
    RESULTS.append((bool(cond), name, extra))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra}")


# 1) Шардировка basket по vol
check("basket vol=1982 -> 13", m.wb_basket_by_volume(1982) == 13,
      f"got {m.wb_basket_by_volume(1982)}")
check("basket vol=143 -> 1", m.wb_basket_by_volume(143) == 1)
check("basket vol=5429 -> 29", m.wb_basket_by_volume(5429) == 29)
# Высокий vol больше НЕ обрывается на 30 (раньше тут была ошибка)
check("basket vol=6000 -> >30 (новые товары)", m.wb_basket_by_volume(6000) > 30,
      f"got {m.wb_basket_by_volume(6000)}")
check("basket vol растёт монотонно", m.wb_basket_by_volume(7000) > m.wb_basket_by_volume(6000))

# 2) certificate_json_urls
urls_low = m.certificate_json_urls(198234567, max_hosts=8)
check("primary шард первым (vol=1982 -> basket-13)", "basket-13" in urls_low[0], urls_low[0])
check("max_hosts уважается", len(urls_low) == 8, f"got {len(urls_low)}")
urls_high = m.certificate_json_urls(600000123, max_hosts=8)  # vol=6000
check("высокий vol -> primary basket>30 в кандидатах",
      any("basket-32" in u or "basket-31" in u or "basket-33" in u for u in urls_high),
      urls_high[0])

# 3) Конкурентность: 8 шардов, КАЖДЫЙ отвечает 404 через 0.2с.
#    Последовательно было бы ~1.6с, конкурентно — ~0.2с.
async def _speed_case():
    sess = FakeSession(default=(404, "", 0.2))
    t0 = time.monotonic()
    urls, status = await m.fetch_certificate_json_for_nm(
        sess, 198234567, timeout_sec=5.0, max_hosts=8, concurrency=8
    )
    return time.monotonic() - t0, urls, status

elapsed, urls, status = _run(_speed_case())
check("no-doc: статус cert_json_no_docs", status.startswith("cert_json_no_docs"), status)
check("no-doc: пустой список ссылок", urls == [])
check("КОНКУРЕНТНО: 8x0.2с заняло < 0.6с (а не ~1.6с)", elapsed < 0.6,
      f"elapsed={elapsed:.2f}s")

# 4) Найдена ссылка на одном из шардов -> ok + быстрый возврат (отмена остальных)
async def _hit_case():
    sess = FakeSession(
        routes={"basket-13": (200, '{"url":"%s"}' % FSA_URL, 0.0)},
        default=(404, "", 0.5),  # прочие медленные
    )
    t0 = time.monotonic()
    urls, status = await m.fetch_certificate_json_for_nm(
        sess, 198234567, timeout_sec=5.0, max_hosts=8, concurrency=8
    )
    return time.monotonic() - t0, urls, status

elapsed, urls, status = _run(_hit_case())
check("hit: статус cert_json_ok", status.startswith("cert_json_ok"), status)
check("hit: вернулась FSA-ссылка", urls and "pub.fsa.gov.ru" in urls[0], str(urls[:1]))
check("hit: ранний возврат < 0.4с (отмена медленных проб)", elapsed < 0.4,
      f"elapsed={elapsed:.2f}s")

# 5) json есть, но ссылки внутри нет -> has_doc_no_url (НЕ «нет документа»)
async def _nodoc_url_case():
    sess = FakeSession(
        routes={"basket-13": (200, '{"foo":"bar"}', 0.0)},
        default=(404, "", 0.0),
    )
    return await m.fetch_certificate_json_for_nm(
        sess, 198234567, timeout_sec=5.0, max_hosts=8, concurrency=8
    )

urls, status = _run(_nodoc_url_case())
check("json без ссылки -> has_doc_no_url", status.startswith("cert_json_has_doc_no_url"), status)

# 6) Все таймауты -> neterror (карточку нужно повторить, НЕ списывать)
async def _timeout_case():
    sess = FakeSession(default=(0, "", 0.0, True))  # raise TimeoutError
    return await m.fetch_certificate_json_for_nm(
        sess, 198234567, timeout_sec=2.0, max_hosts=6, concurrency=6
    )

urls, status = _run(_timeout_case())
check("все таймауты -> cert_json_neterror", status.startswith("cert_json_neterror"), status)


# 7) РЕГРЕССИЯ: высокий vol больше НЕ перелетает в несуществующие basket-50+
check("vol=8004 -> basket≈37 (по реальным данным)", m.wb_basket_by_volume(8004) == 37,
      f"got {m.wb_basket_by_volume(8004)}")
check("vol=9808 -> basket в реальном диапазоне (<=46), а не 50+",
      m.wb_basket_by_volume(9808) <= 46, f"got {m.wb_basket_by_volume(9808)}")
high_urls = m.certificate_json_urls(980839943, max_hosts=14)  # vol 9808
import re as _re
high_baskets = [int(_re.search(r"basket-(\d+)", u).group(1)) for u in high_urls]
check("кандидаты высокого vol включают реальные шарды 30..40",
      any(30 <= b <= 40 for b in high_baskets), str(high_baskets))


# 8) РЕГРЕССИЯ: DNS-ошибка (несуществующий basket-хост) = «нет файла», НЕ ОШИБКА.
#    Раньше это давало cert_json_neterror -> карточка помечалась ОШИБКОЙ.
async def _dns_case():
    # часть хостов 404, часть — несуществующие (DNS); ни одного 200
    sess = FakeSession(
        routes={"basket-37": (404, "", 0.0), "basket-36": (404, "", 0.0)},
        default=(0, "", 0.0, "dns"),  # остальные не резолвятся
    )
    return await m.fetch_certificate_json_for_nm(
        sess, 980839943, timeout_sec=2.0, max_hosts=8, concurrency=8
    )

urls, status = _run(_dns_case())
check("DNS-несуществующие шарды -> cert_json_no_docs (не neterror)",
      status.startswith("cert_json_no_docs"), status)


# --------------------------------------------------------------------------
if __name__ == "__main__":
    passed = sum(1 for ok, _, _ in RESULTS if ok)
    total = len(RESULTS)
    print("-" * 70)
    print(f"ИТОГО: {passed}/{total} прошло")
    sys.exit(0 if passed == total else 1)
