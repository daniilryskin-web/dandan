"""
Регрессионный тест: при СЕТЕВОМ сбое pub.fsa.gov.ru парсер FSA должен падать
БЫСТРО — не перебирая вкладки /baseInfo -> /product -> /manufacturer по 30с
каждую. Раньше один недоступный документ занимал воркер ~114с и этап 2 «висел».

Мокаем page так, что любой goto бросает net::ERR_CONNECTION_TIMED_OUT, и
проверяем, что:
  • функция возвращает NETWORK_FAILURE_all_goto_failed;
  • сработал ранний обрыв number-маршрутов (number_routes_network_abort);
  • вкладки product/manufacturer НЕ навигировались (быстрый выход).

Запуск:  python3 tests/test_fsa_fastfail.py
"""
import asyncio
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


class _FakeError(Exception):
    """Имитация playwright Error с сетевым текстом."""


class _ExpectCtx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False  # пропускаем исключение из goto наружу

    @property
    def value(self):  # не должно дойти
        raise AssertionError("expect_response.value не должен запрашиваться")


class _FakePage:
    def __init__(self):
        self.goto_urls = []

    def expect_response(self, matcher, timeout=None):
        return _ExpectCtx()

    async def goto(self, url, wait_until=None, timeout=None):
        self.goto_urls.append(url)
        raise _FakeError(
            f'Page.goto: net::ERR_CONNECTION_TIMED_OUT at {url} '
            f'Call log: - navigating to "{url}", waiting until "domcontentloaded"')

    async def evaluate(self, *a, **k):
        return ""

    async def wait_for_timeout(self, *a, **k):
        return None


class _Args:
    fsa_http_fast_path = False          # пропускаем HTTP fast-path (без сети)
    registry_browser_wait_ms = 500
    registry_browser_timeout_ms = 1000
    user_agent = "test-agent"


async def _run():
    url = "https://pub.fsa.gov.ru/rds/declaration/view/18116918/common"
    page = _FakePage()
    cert, prod, typ, status, detail = await m._parse_fsa_with_existing_page_v386(page, url, _Args())
    return cert, prod, typ, status, detail, page.goto_urls


def main():
    cert, prod, typ, status, detail, goto_urls = asyncio.run(_run())
    print("  detail:", detail[:200])
    print("  goto_urls:", goto_urls)
    check("нет названия продукции (сетевой сбой)", not prod)
    check("помечено NETWORK_FAILURE_all_goto_failed", "NETWORK_FAILURE_all_goto_failed" in detail)
    check("ранний обрыв number-маршрутов", "number_routes_network_abort" in detail)
    # тип документа определён по url, даже при сбое
    check("doc_type=декларация", typ == "декларация")
    # КЛЮЧЕВОЕ: ни одна product/manufacturer-вкладка не навигировалась
    bad = [u for u in goto_urls if u.endswith("/product") or u.endswith("/manufacturer")]
    check("вкладки product/manufacturer НЕ открывались", not bad)
    # И всего навигаций мало (не перебор всех вкладок)
    check("мало попыток goto (быстрый выход)", len(goto_urls) <= 3)


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
