"""
ozon_parser_playwright.py — v27.6: Браузерный (Playwright) парсер Ozon.

Создан после провала HTTP-парсинга в v27.4–v27.5 (CloudFlare блокирует ~99% запросов).
Реализация по статье habr.com/ru/companies/amvera/articles/960280 — подтверждает,
что HTTP API Ozon на 2024–2025 заблокирован, остаётся только браузер.

Архитектура:
  1. Запускаем Chromium в стелс-режиме (webdriver=undefined, plugins=[1..5], realistic UA).
  2. Открываем https://www.ozon.ru/search/?text={query}&from_global=true
  3. Скроллим, собираем ссылки a[href*='/product/'].
  4. Для каждого товара открываем карточку, извлекаем поля через CSS-селекторы.
  5. Маппим в OzonResultRow (определён в ozon_parser.py) для совместимости.

ВАЖНО: модуль использует OzonResultRow и save_xlsx из ozon_parser.py — не дублирует их.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import re
import sys
import time
import traceback
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote_plus, urlparse

# Импортируем общие структуры и утилиты из основного модуля
try:
    from ozon_parser import (
        OzonResultRow,
        save_xlsx,
        save_csv,
        now_iso,
        _write_diagnostic_xlsx,
        _write_run_log,
    )
except ImportError as e:
    print(f"[FATAL] Не удалось импортировать ozon_parser: {e}")
    sys.exit(1)

try:
    from playwright.async_api import async_playwright, Page, Browser, BrowserContext
    PLAYWRIGHT_OK = True
except ImportError:
    PLAYWRIGHT_OK = False

log = logging.getLogger("ozon_playwright")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

# ---------------------------------------------------------------------------
# Стелс-настройки (по habr-статье 960280)
# ---------------------------------------------------------------------------

UA_MAC = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

VIEWPORT = {"width": 1920, "height": 1080}

BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-features=IsolateOrigins,site-per-process",
    "--lang=ru-RU",
]

# JS-инъекция для подмены webdriver, plugins, languages
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(i => ({ name: `Plugin ${i}`, length: 1 })),
});
Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
const origPermQuery = window.navigator.permissions && window.navigator.permissions.query;
if (origPermQuery) {
    window.navigator.permissions.query = (params) => (
        params && params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origPermQuery(params)
    );
}
"""


async def _human_delay(min_s: float = 1.0, max_s: float = 3.0) -> None:
    """Имитация человеческой задержки."""
    await asyncio.sleep(random.uniform(min_s, max_s))


# ---------------------------------------------------------------------------
# Парсер карточек
# ---------------------------------------------------------------------------

PRICE_RE = re.compile(r"[\d\s]+")


def _parse_price_text(text: str) -> float:
    """Извлекает число рублей из строки вида '1 234 ₽'."""
    if not text:
        return 0.0
    m = PRICE_RE.search(text.replace("\u202f", " ").replace("\xa0", " "))
    if not m:
        return 0.0
    digits = re.sub(r"\D", "", m.group(0))
    return float(digits) if digits else 0.0


def _extract_sku_from_url(url: str) -> str:
    """Из URL вида https://www.ozon.ru/product/nazvanie-tovara-1234567890/ → '1234567890'."""
    if not url:
        return ""
    m = re.search(r"/product/[^/]*?-(\d{6,})(?:/|\?|$)", url)
    if m:
        return m.group(1)
    m = re.search(r"/product/(\d{6,})", url)
    return m.group(1) if m else ""


class OzonPlaywrightParser:
    """Парсер Ozon на основе Playwright + стелс-настроек."""

    def __init__(
        self,
        headless: bool = True,
        delay_min_s: float = 1.0,
        delay_max_s: float = 3.0,
        card_timeout_ms: int = 30000,
        search_timeout_ms: int = 45000,
    ):
        self.headless = headless
        self.delay_min_s = delay_min_s
        self.delay_max_s = delay_max_s
        self.card_timeout_ms = card_timeout_ms
        self.search_timeout_ms = search_timeout_ms

        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None

        # Диагностика
        self.stats: Dict[str, int] = {
            "search_attempts": 0,
            "search_success": 0,
            "search_fail": 0,
            "cards_attempts": 0,
            "cards_success": 0,
            "cards_fail": 0,
            "cf_blocks": 0,
        }

    async def __aenter__(self) -> "OzonPlaywrightParser":
        if not PLAYWRIGHT_OK:
            raise RuntimeError(
                "Playwright не установлен. Выполните: pip install playwright && playwright install chromium"
            )
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=self.headless,
            args=BROWSER_ARGS,
        )
        self._context = await self._browser.new_context(
            user_agent=UA_MAC,
            viewport=VIEWPORT,
            locale="ru-RU",
            timezone_id="Europe/Moscow",
            extra_http_headers={
                "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
            },
        )
        await self._context.add_init_script(STEALTH_JS)
        log.info("Playwright Chromium запущен (headless=%s)", self.headless)
        return self

    async def __aexit__(self, *args) -> None:
        try:
            if self._context:
                await self._context.close()
            if self._browser:
                await self._browser.close()
            if self._playwright:
                await self._playwright.stop()
        except Exception as e:
            log.debug("Ошибка при закрытии Playwright: %s", e)

    # -----------------------------------------------------------------------
    # Поиск товаров (этап 1)
    # -----------------------------------------------------------------------

    async def search(self, query: str, limit: int = 20) -> List[Dict[str, str]]:
        """
        Открывает страницу поиска, скроллит, собирает ссылки на товары.
        Возвращает [{"sku": "...", "url": "...", "title": "..."}].
        """
        self.stats["search_attempts"] += 1
        url = f"https://www.ozon.ru/search/?text={quote_plus(query)}&from_global=true"
        log.info("Открываю поиск: %s (лимит %d)", url, limit)

        page = await self._context.new_page()
        try:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=self.search_timeout_ms)
            except Exception as e:
                log.warning("Не удалось открыть поиск: %s", e)
                self.stats["search_fail"] += 1
                return []

            # Имитируем человеческие движения
            await _human_delay(self.delay_min_s, self.delay_max_s)

            # Проверка CF-блокировки
            content = await page.content()
            if any(s in content.lower() for s in ["проверка безопасности", "cloudflare", "доступ ограничен", "captcha"]):
                self.stats["cf_blocks"] += 1
                log.warning("CF-блокировка на странице поиска")
                # Ждём прохождения CF (до 15 сек)
                for _ in range(15):
                    await asyncio.sleep(1.0)
                    content = await page.content()
                    if not any(s in content.lower() for s in ["cloudflare", "captcha"]):
                        break

            # Скроллим вниз, чтобы подгрузились товары
            seen_links: Dict[str, Dict[str, str]] = {}
            for scroll_idx in range(8):  # до 8 раз скроллим
                links = await self._extract_product_links(page)
                for lnk in links:
                    sku = _extract_sku_from_url(lnk["url"])
                    if sku and sku not in seen_links:
                        lnk["sku"] = sku
                        seen_links[sku] = lnk
                if len(seen_links) >= limit:
                    break
                # Прокрутка
                try:
                    await page.evaluate("window.scrollBy(0, window.innerHeight * 1.5)")
                except Exception:
                    pass
                await _human_delay(0.8, 1.6)

            result = list(seen_links.values())[:limit]
            log.info("Найдено товаров: %d (запрошено %d)", len(result), limit)
            if result:
                self.stats["search_success"] += 1
            else:
                self.stats["search_fail"] += 1
            return result
        finally:
            try:
                await page.close()
            except Exception:
                pass

    async def _extract_product_links(self, page: Page) -> List[Dict[str, str]]:
        """Извлекает ссылки на товары со страницы поиска."""
        try:
            data = await page.evaluate(
                """
                () => {
                    const anchors = document.querySelectorAll("a[href*='/product/']");
                    const seen = new Set();
                    const out = [];
                    anchors.forEach(a => {
                        let href = a.getAttribute('href') || '';
                        if (!href || !href.includes('/product/')) return;
                        if (href.startsWith('/')) href = 'https://www.ozon.ru' + href;
                        // нормализуем — убираем query/fragment
                        try {
                            const u = new URL(href);
                            href = u.origin + u.pathname;
                        } catch(e) {}
                        if (seen.has(href)) return;
                        seen.add(href);
                        const text = (a.innerText || '').trim().slice(0, 300);
                        out.push({ url: href, title: text });
                    });
                    return out;
                }
                """
            )
            return data or []
        except Exception as e:
            log.debug("Ошибка извлечения ссылок: %s", e)
            return []

    # -----------------------------------------------------------------------
    # Парсинг карточки (этап 2)
    # -----------------------------------------------------------------------

    async def parse_card(self, product_url: str, query: str = "") -> Optional[OzonResultRow]:
        """Открывает карточку, извлекает поля, возвращает OzonResultRow."""
        self.stats["cards_attempts"] += 1
        page = await self._context.new_page()
        try:
            try:
                await page.goto(product_url, wait_until="domcontentloaded", timeout=self.card_timeout_ms)
            except Exception as e:
                log.warning("Не удалось открыть карточку %s: %s", product_url, e)
                self.stats["cards_fail"] += 1
                return self._empty_row(product_url, query, status=f"card_goto_error: {type(e).__name__}")

            await _human_delay(self.delay_min_s, self.delay_max_s)

            # Проверка CF
            content = await page.content()
            if any(s in content.lower() for s in ["проверка безопасности", "cloudflare", "captcha"]):
                self.stats["cf_blocks"] += 1
                # ждём
                for _ in range(10):
                    await asyncio.sleep(1.0)
                    content = await page.content()
                    if not any(s in content.lower() for s in ["cloudflare", "captcha"]):
                        break

            # Извлечение данных через JS
            try:
                card_data = await page.evaluate(self._CARD_EXTRACT_JS)
            except Exception as e:
                log.warning("JS-extract упал на %s: %s", product_url, e)
                self.stats["cards_fail"] += 1
                return self._empty_row(product_url, query, status=f"js_extract_error: {type(e).__name__}")

            sku = _extract_sku_from_url(product_url)
            row = OzonResultRow(
                query=query,
                nm_id=int(sku) if sku.isdigit() else 0,
                product_name=(card_data.get("title") or "")[:500],
                brand=(card_data.get("brand") or "")[:200],
                subject=(card_data.get("category") or "")[:200],
                product_url=product_url,
                status="OK",
                price_rub=_parse_price_text(card_data.get("price") or ""),
                sale_price_rub=_parse_price_text(card_data.get("sale_price") or ""),
                seller_name=(card_data.get("seller") or "")[:200],
                supplier_id="",
                rating=float(card_data.get("rating") or 0.0),
                feedbacks=int(card_data.get("reviews_count") or 0),
                is_original="",
                checked_at=now_iso(),
                ozon_sku=sku,
                ozon_seller_url=card_data.get("seller_url") or "",
                ozon_brand_url=card_data.get("brand_url") or "",
                ozon_docs_raw=json.dumps(card_data.get("docs") or [], ensure_ascii=False)[:5000],
                ozon_characteristics=json.dumps(card_data.get("chars") or [], ensure_ascii=False)[:5000],
                ozon_original_mark_info=card_data.get("original_mark") or "",
                details=f"playwright_card; widgets_seen={len(card_data.get('widgets', []))}",
                worker="ozon_playwright",
            )
            self.stats["cards_success"] += 1
            return row
        finally:
            try:
                await page.close()
            except Exception:
                pass

    def _empty_row(self, url: str, query: str, status: str) -> OzonResultRow:
        sku = _extract_sku_from_url(url)
        return OzonResultRow(
            query=query,
            nm_id=int(sku) if sku.isdigit() else 0,
            product_url=url,
            status=status,
            checked_at=now_iso(),
            ozon_sku=sku,
            worker="ozon_playwright",
        )

    _CARD_EXTRACT_JS = r"""
    () => {
        const safe = (sel, attr) => {
            const el = document.querySelector(sel);
            if (!el) return '';
            if (attr) return el.getAttribute(attr) || '';
            return (el.innerText || el.textContent || '').trim();
        };
        const safeAll = (sel) => {
            return Array.from(document.querySelectorAll(sel))
                .map(e => (e.innerText || '').trim())
                .filter(t => t);
        };

        // Заголовок
        const title = safe('h1') || safe('[data-widget="webProductHeading"] h1') || '';

        // Бренд (часто ссылка a[href*='/brand/'])
        let brand = '';
        let brand_url = '';
        const brandEl = document.querySelector('a[href*="/brand/"]') || document.querySelector('[data-widget="webBrand"] a');
        if (brandEl) {
            brand = (brandEl.innerText || '').trim();
            brand_url = brandEl.getAttribute('href') || '';
            if (brand_url && brand_url.startsWith('/')) brand_url = 'https://www.ozon.ru' + brand_url;
        }

        // Цена
        const priceWidget = document.querySelector('[data-widget="webPrice"]') || document.querySelector('[data-widget="webOzonAccountPrice"]');
        let price = '', sale_price = '';
        if (priceWidget) {
            const spans = Array.from(priceWidget.querySelectorAll('span')).map(s => (s.innerText || '').trim()).filter(t => /\d/.test(t));
            if (spans.length >= 2) {
                sale_price = spans[0];
                price = spans[1];
            } else if (spans.length === 1) {
                sale_price = spans[0];
                price = spans[0];
            }
        }

        // Рейтинг + кол-во отзывов
        let rating = 0, reviews_count = 0;
        const reviewWidget = document.querySelector('[data-widget="webSingleProductScore"]') ||
                             document.querySelector('[data-widget="webReviewProductScore"]') ||
                             document.querySelector('[data-widget="webReviewRating"]');
        if (reviewWidget) {
            const txt = (reviewWidget.innerText || '').trim();
            const ratingM = txt.match(/(\d+[.,]\d+)/);
            if (ratingM) rating = parseFloat(ratingM[1].replace(',', '.'));
            const revM = txt.match(/(\d[\d\s]*)\s*(отзыв|оценок|обзор)/i);
            if (revM) reviews_count = parseInt(revM[1].replace(/\s/g, ''), 10) || 0;
        }
        if (!reviews_count) {
            const rc = document.querySelector('[data-widget="webReviewCount"]');
            if (rc) {
                const m = (rc.innerText || '').match(/(\d[\d\s]*)/);
                if (m) reviews_count = parseInt(m[1].replace(/\s/g, ''), 10) || 0;
            }
        }

        // Продавец (a[href*='/seller/'])
        let seller = '';
        let seller_url = '';
        const sellerEl = document.querySelector('a[href*="/seller/"]') || document.querySelector('[data-widget="webCurrentSeller"] a');
        if (sellerEl) {
            seller = (sellerEl.innerText || '').trim();
            seller_url = sellerEl.getAttribute('href') || '';
            if (seller_url && seller_url.startsWith('/')) seller_url = 'https://www.ozon.ru' + seller_url;
        }

        // Категория — крошки
        let category = '';
        const crumbs = Array.from(document.querySelectorAll('[data-widget="breadCrumbs"] a, [data-widget="breadCrumbs"] span'))
            .map(e => (e.innerText || '').trim()).filter(t => t);
        if (crumbs.length) category = crumbs[crumbs.length - 1];

        // Характеристики (могут быть в табе)
        const chars = [];
        document.querySelectorAll('[data-widget="webShortCharacteristics"] dl, [data-widget="webCharacteristics"] dl').forEach(dl => {
            const dts = dl.querySelectorAll('dt');
            const dds = dl.querySelectorAll('dd');
            for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
                chars.push({
                    name: (dts[i].innerText || '').trim(),
                    value: (dds[i].innerText || '').trim(),
                });
            }
        });

        // Документы (вкладка «Документы продавца» если есть)
        const docs = [];
        document.querySelectorAll('[data-widget="webProductDocuments"] a, a[href*="document"]').forEach(a => {
            const href = a.getAttribute('href') || '';
            if (href && /docs|document|cert|declar/i.test(href)) {
                docs.push({
                    url: href.startsWith('/') ? 'https://www.ozon.ru' + href : href,
                    text: (a.innerText || '').trim(),
                });
            }
        });

        // Метка оригинала
        let original_mark = '';
        const omEl = document.querySelector('[class*="originalMark"], [class*="origin-mark"]');
        if (omEl) original_mark = (omEl.innerText || '').trim();

        // Сбор использованных виджетов (для диагностики)
        const widgets = Array.from(document.querySelectorAll('[data-widget]')).map(e => e.getAttribute('data-widget')).filter((v, i, a) => a.indexOf(v) === i).slice(0, 50);

        return {
            title, brand, brand_url, price, sale_price,
            rating, reviews_count, seller, seller_url, category,
            chars, docs, original_mark, widgets,
        };
    }
    """


# ---------------------------------------------------------------------------
# Главный runner
# ---------------------------------------------------------------------------

async def run_playwright_parser(
    query: str,
    limit: int,
    workers: int,
    headless: bool,
    output: str,
    expiry_warning_days: int,
    make_report_xlsx: bool,
    run_log: str,
    delay_min_ms: int = 800,
    delay_max_ms: int = 2500,
) -> int:
    """Главная асинхронная функция-runner. Возвращает код возврата."""
    if not PLAYWRIGHT_OK:
        print("[ERROR] Playwright не установлен.")
        print("[ERROR] Установите: pip install playwright && playwright install chromium")
        return 2

    started = time.time()
    output_path = Path(output)
    delay_min_s = delay_min_ms / 1000.0
    delay_max_s = delay_max_ms / 1000.0

    print(f"[Ozon-Playwright] query={query!r} limit={limit} workers={workers} headless={headless}")
    print(f"[Ozon-Playwright] output={output_path}")

    rows: List[OzonResultRow] = []
    diag: Dict[str, Any] = {
        "started_at": now_iso(),
        "query": query,
        "limit": limit,
        "workers": workers,
        "engine": "ozon_playwright_v27.6",
        "playwright_available": True,
        "diagnosis": "",
    }

    try:
        async with OzonPlaywrightParser(
            headless=headless,
            delay_min_s=delay_min_s,
            delay_max_s=delay_max_s,
        ) as parser:
            # Этап 1: поиск
            t0 = time.time()
            search_results = await parser.search(query, limit=limit)
            print(f"[Ozon-Playwright] поиск: {len(search_results)} ссылок за {time.time()-t0:.1f}с")

            if not search_results:
                print("[Ozon-Playwright] Поиск не дал результатов")
                diag["error"] = "search_empty"
                diag["diagnosis"] = (
                    "Поиск не вернул товаров — возможно, CloudFlare/капча или нет товаров по запросу. "
                    f"CF-блокировок зафиксировано: {parser.stats.get('cf_blocks', 0)}"
                )
                diag.update({f"stat_{k}": v for k, v in parser.stats.items()})
                # Всё равно пишем пустой xlsx с диагностикой
                if make_report_xlsx and output_path.suffix.lower() == ".xlsx":
                    try:
                        _write_diagnostic_xlsx(output_path, query, started, diag)
                    except Exception as e:
                        log.warning("Не удалось записать диагностический xlsx: %s", e)
                return 0

            # Этап 2: карточки последовательно (1 браузерный контекст, чтобы не палиться)
            # workers здесь не используем — Ozon агрессивно банит при параллели
            t1 = time.time()
            for idx, item in enumerate(search_results, 1):
                url = item.get("url", "")
                if not url:
                    continue
                print(f"[Ozon-Playwright] карточка {idx}/{len(search_results)}: {url}", flush=True)
                try:
                    row = await parser.parse_card(url, query=query)
                    if row:
                        rows.append(row)
                except Exception as e:
                    log.warning("Ошибка обработки %s: %s", url, e)
                # Промежуточный xlsx каждые 5 карточек
                if idx % 5 == 0 and rows and output_path.suffix.lower() == ".xlsx":
                    try:
                        save_xlsx(
                            rows, output_path,
                            expiry_warning_days=expiry_warning_days,
                            make_report_xlsx=make_report_xlsx,
                        )
                    except Exception as e:
                        log.debug("Промежуточный xlsx не записан: %s", e)

            print(f"[Ozon-Playwright] карточки: {len(rows)} собрано за {time.time()-t1:.1f}с")
            diag.update({f"stat_{k}": v for k, v in parser.stats.items()})
            diag["items_collected"] = len(rows)
    except KeyboardInterrupt:
        print("[Ozon-Playwright] Прерван пользователем")
        diag["error"] = "interrupted"
    except Exception as e:
        log.exception("Критическая ошибка")
        diag["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        diag["traceback"] = traceback.format_exc()[:2000]

    diag["finished_at"] = now_iso()
    diag["elapsed_sec"] = round(time.time() - started, 1)
    diag["rows_count"] = len(rows)

    # Финальная запись
    try:
        if output_path.suffix.lower() == ".csv":
            save_csv(rows, output_path)
        elif rows:
            save_xlsx(
                rows, output_path,
                expiry_warning_days=expiry_warning_days,
                make_report_xlsx=make_report_xlsx,
            )
        else:
            # Нет строк — диагностический xlsx
            _write_diagnostic_xlsx(output_path, query, started, diag)
    except Exception as e:
        log.error("Не удалось сохранить результаты: %s", e)
        traceback.print_exc()
        return 1

    # Лог прогона
    log_path = Path(run_log) if run_log else None
    try:
        _write_run_log(rows, output_path, expiry_warning_days, started, log_path)
    except Exception as e:
        log.debug("Run log не записан: %s", e)

    print(f"[Ozon-Playwright] Готово: {len(rows)} строк → {output_path}")
    return 0


def main() -> None:
    """Точка входа CLI (вызывается из ozon_parser.py через диспетчер)."""
    ap = argparse.ArgumentParser(
        description="Ozon Playwright parser v27.6",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--query", required=True)
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--workers", type=int, default=1)  # для Ozon-Playwright параллель опасна
    ap.add_argument("--headless", type=lambda s: str(s).lower() in ("1", "true", "yes"), default=True)
    ap.add_argument("--output", default="ozon_result.xlsx")
    ap.add_argument("--expiry-warning-days", type=int, default=30)
    ap.add_argument("--make-report-xlsx", type=lambda s: str(s).lower() in ("1", "true", "yes"), default=True)
    ap.add_argument("--run-log", default="")
    ap.add_argument("--delay-min-ms", type=int, default=800)
    ap.add_argument("--delay-max-ms", type=int, default=2500)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    rc = asyncio.run(run_playwright_parser(
        query=args.query,
        limit=args.limit,
        workers=args.workers,
        headless=args.headless,
        output=args.output,
        expiry_warning_days=args.expiry_warning_days,
        make_report_xlsx=args.make_report_xlsx,
        run_log=args.run_log,
        delay_min_ms=args.delay_min_ms,
        delay_max_ms=args.delay_max_ms,
    ))
    sys.exit(rc)


if __name__ == "__main__":
    main()
