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
        # v27.7: переиспользуем готовый парсер JSON-виджетов и обогащение реестрами
        parse_widget_states,
        extract_documents_from_widgets,
        extract_original_mark,
        resolve_registry_url_from_documents,
        enrich_registry_data,
        _parse_price,
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


# Эндпоинты внутреннего JSON-API Ozon, которые отдают widgetStates.
# Перехват их ответов — основной способ получить ЧИСТЫЕ данные карточки
# (название, цена, продавец, документы, метка «Оригинал»), а не парсить
# хрупкие/обфусцированные CSS-классы DOM.
_OZON_API_MARKERS = (
    "entrypoint-api.bx/page/json",
    "composer-api.bx/page/json",
)


def _attach_widget_capture(page: "Page") -> Dict[str, str]:
    """
    Вешает на страницу обработчик ответов, который собирает widgetStates из
    всех JSON-ответов Ozon-API в один общий словарь.

    Возвращает dict, который наполняется асинхронно по мере прихода ответов.
    Ключи — имена виджетов (как в widgetStates), значения — сырой JSON-текст.
    """
    captured: Dict[str, str] = {}

    async def on_response(response: Any) -> None:
        try:
            url_r = response.url or ""
            if not any(m in url_r for m in _OZON_API_MARKERS):
                return
            ctype = (response.headers or {}).get("content-type", "")
            if "json" not in ctype.lower():
                return
            data = await response.json()
            if isinstance(data, dict):
                ws = data.get("widgetStates")
                if isinstance(ws, dict):
                    # Не затираем уже непустые значения пустыми
                    for k, v in ws.items():
                        if k not in captured or (v and not captured.get(k)):
                            captured[k] = v
        except Exception:
            # Тихо игнорируем — это лишь один из многих ответов
            pass

    page.on("response", on_response)
    return captured


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


def _extract_product_links_from_capture(captured: Dict[str, str]) -> List[Dict[str, str]]:
    """v27.9.x: достаёт ссылки на товары из ПЕРЕХВАЧЕННОГО JSON Ozon (widgetStates).

    Поиск Ozon отдаёт карточки в composer/entrypoint-api JSON. Раньше ссылки
    брались ТОЛЬКО из DOM (a[href*='/product/']) — а Ozon часто рендерит выдачу
    так, что прямых anchor'ов нет (виртуализация, шаблоны), и поиск возвращал 0.
    Здесь ловим /product/...-<sku> прямо в перехваченном JSON — это устойчивее
    к изменениям вёрстки.
    """
    out: Dict[str, Dict[str, str]] = {}
    rx = re.compile(r"/product/[A-Za-z0-9_\-]+?-(\d{6,})")
    for raw in (captured or {}).values():
        if not raw:
            continue
        text = raw.replace("\\/", "/")  # JSON часто экранирует слэши
        for m in rx.finditer(text):
            sku = m.group(1)
            path = m.group(0)
            if sku not in out:
                out[sku] = {"url": "https://www.ozon.ru" + path, "title": "", "sku": sku}
    return list(out.values())


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
        # v27.9.x: перехватываем JSON выдачи (надёжнее DOM-ссылок).
        captured = _attach_widget_capture(page)
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
                # 1) ссылки из DOM
                links = await self._extract_product_links(page)
                # 2) ссылки из перехваченного JSON (устойчивее к вёрстке)
                links += _extract_product_links_from_capture(captured)
                for lnk in links:
                    sku = lnk.get("sku") or _extract_sku_from_url(lnk["url"])
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
        """
        Открывает карточку и собирает данные.

        v27.7: основной источник данных — перехват JSON-ответов Ozon-API
        (widgetStates), которые парсятся готовыми parse_widget_states /
        extract_documents_from_widgets / extract_original_mark из ozon_parser.
        DOM-скрейпинг по CSS-селекторам остаётся лишь как fallback, если API
        ничего не отдал. Это убирает зависимость от обфусцированных классов и,
        главное, наполняет документы и реестровую ссылку.
        """
        self.stats["cards_attempts"] += 1
        page = await self._context.new_page()
        try:
            captured = _attach_widget_capture(page)
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
                for _ in range(10):
                    await asyncio.sleep(1.0)
                    content = await page.content()
                    if not any(s in content.lower() for s in ["cloudflare", "captcha"]):
                        break

            # Прокручиваем карточку — это триггерит ленивую подгрузку виджетов
            # (характеристики, документы продавца, метка «Оригинал»),
            # которые приходят отдельными entrypoint-api ответами.
            for _ in range(4):
                try:
                    await page.evaluate("window.scrollBy(0, window.innerHeight * 1.2)")
                except Exception:
                    pass
                await asyncio.sleep(0.6)
            # Даём дозагрузиться последним XHR
            await asyncio.sleep(1.0)

            sku = _extract_sku_from_url(product_url)

            # --- ОСНОВНОЙ путь: разбор перехваченных widgetStates ---
            card = None
            documents: List[Dict[str, Any]] = []
            is_original = ""
            original_info = ""
            widgets_seen = len(captured)
            if captured:
                try:
                    card = parse_widget_states(captured)
                    documents = list(card.documents or [])
                    if not documents:
                        documents = extract_documents_from_widgets(captured)
                    is_original = card.is_original or ""
                    original_info = card.original_mark_info or ""
                    if not is_original:
                        is_original, original_info2 = extract_original_mark(captured)
                        original_info = original_info or original_info2
                except Exception as e:
                    log.debug("Разбор widgetStates упал на %s: %s", product_url, e)
                    card = None

            # --- FALLBACK: DOM-скрейпинг, если API ничего не дал ---
            dom = {}
            if not card or not (card.product_name or "").strip():
                try:
                    dom = await page.evaluate(self._CARD_EXTRACT_JS)
                except Exception as e:
                    log.debug("DOM-fallback упал на %s: %s", product_url, e)
                    dom = {}

            # Собираем итоговые значения (приоритет — данные из API)
            def _pick(api_val: Any, dom_val: Any) -> str:
                s = str(api_val or "").strip()
                return s if s else str(dom_val or "").strip()

            product_name = _pick(getattr(card, "product_name", ""), dom.get("title"))
            brand = _pick(getattr(card, "brand", ""), dom.get("brand"))
            subject = _pick(getattr(card, "category", ""), dom.get("category"))
            seller_name = _pick(getattr(card, "seller_name", ""), dom.get("seller"))
            seller_url = _pick(getattr(card, "seller_url", ""), dom.get("seller_url"))
            brand_url = _pick(getattr(card, "brand_url", ""), dom.get("brand_url"))
            price_rub = float(getattr(card, "price_rub", 0.0) or 0.0) or _parse_price_text(dom.get("price") or "")
            sale_price_rub = float(getattr(card, "sale_price_rub", 0.0) or 0.0) or _parse_price_text(dom.get("sale_price") or "")
            rating = float(getattr(card, "rating", 0.0) or 0.0) or float(dom.get("rating") or 0.0)
            feedbacks = int(getattr(card, "feedbacks", 0) or 0) or int(dom.get("reviews_count") or 0)
            characteristics = getattr(card, "characteristics", None) or dom.get("chars") or []
            if not documents and dom.get("docs"):
                documents = dom.get("docs") or []
            if not is_original:
                is_original = dom.get("original_mark") or ""

            # Резолвим реестровую ссылку из документов карточки
            registry_url, registry_host, registry_record_id = "", "", ""
            if documents:
                try:
                    registry_url, registry_host, registry_record_id = \
                        resolve_registry_url_from_documents(documents)
                except Exception as e:
                    log.debug("resolve_registry_url упал на %s: %s", product_url, e)

            # Честный подсчёт: карточка успешна только при непустом названии
            ok = bool(product_name)
            row = OzonResultRow(
                query=query,
                nm_id=int(sku) if sku.isdigit() else 0,
                product_name=product_name[:500],
                brand=brand[:200],
                subject=subject[:200],
                product_url=product_url,
                status="OK" if ok else "EMPTY_CARD",
                price_rub=price_rub,
                sale_price_rub=sale_price_rub,
                seller_name=seller_name[:200],
                supplier_id=str(getattr(card, "seller_id", "") or ""),
                rating=rating,
                feedbacks=feedbacks,
                is_original=is_original,
                registry_url=registry_url,
                registry_host=registry_host,
                registry_record_id=registry_record_id,
                checked_at=now_iso(),
                ozon_sku=sku,
                ozon_seller_url=seller_url,
                ozon_brand_url=brand_url,
                ozon_docs_raw=json.dumps(documents or [], ensure_ascii=False)[:5000],
                ozon_characteristics=json.dumps(characteristics or [], ensure_ascii=False)[:5000],
                ozon_original_mark_info=original_info or "",
                details=f"src={'api' if widgets_seen else 'dom'}; widgets={widgets_seen}; docs={len(documents)}",
                worker="ozon_playwright",
            )
            if ok:
                self.stats["cards_success"] += 1
            else:
                self.stats["cards_fail"] += 1
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

def _apply_ozon_verdicts(rows: List[OzonResultRow]) -> None:
    """
    Выносит финальный вердикт сверки названия карточки с названием из реестра.

    Переиспользует единый алгоритм compare_product_names из main_v39, чтобы
    Ozon и WB оценивались одинаково по всем категориям. Вердикт пишется в
    row.status — так же, как это делает WB-движок (status=verdict).
    """
    try:
        from main_v39 import compare_product_names
    except Exception as e:
        log.warning("compare_product_names недоступна (%s) — вердикт пропущен", e)
        return

    BELGISS_HOSTS = ("belgiss.by", "www.belgiss.by", "tsouz.belgiss.by")
    for r in rows:
        if not r.registry_url:
            continue
        prod = (r.certificate_product_name or "").strip()
        try:
            verdict, score, cmp_details = compare_product_names(
                r.product_name or "", prod,
                brand=r.brand or "", subject=r.subject or "",
                doc_status=r.document_status or "",
            )
        except Exception as e:
            log.debug("compare_product_names упал: %s", e)
            continue
        if not prod and verdict != "НЕДЕЙСТВУЮЩИЙ ДОКУМЕНТ":
            if r.certificate_number and (r.registry_host or "") in BELGISS_HOSTS:
                verdict, score = "НОМЕР ИЗВЛЕЧЁН ИЗ РЕЕСТРА", 0.5
            else:
                verdict, score = "НЕ УДАЛОСЬ ИЗВЛЕЧЬ НАЗВАНИЕ ИЗ РЕЕСТРА", 0.0
        r.status = verdict
        r.score = float(score or 0.0)
        if cmp_details:
            r.details = (r.details + " | " if r.details else "") + str(cmp_details)[:300]


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
                    from main_v39 import emit_progress as _emit
                    _emit("cards", idx, len(search_results))
                except Exception:
                    pass
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

        # --- Этап 3: обогащение данными из реестров (ФСА/SWIS/Belgiss) ---
        # Это ГЛАВНАЯ функция проекта — в прежней версии она не вызывалась
        # из браузерного пути, поэтому сверка с реестрами не выполнялась.
        n_with_reg = sum(1 for r in rows if r.registry_url)
        if n_with_reg:
            print(f"[Ozon-Playwright] обогащение реестрами: {n_with_reg} карточек с реестровой ссылкой", flush=True)
            t2 = time.time()
            try:
                from main_v39 import emit_progress as _emit
                _emit("registry", 0, n_with_reg)
            except Exception:
                pass
            try:
                rows = await enrich_registry_data(rows, workers=8, timeout_sec=12.0)
            except Exception as e:
                log.warning("Обогащение реестрами упало: %s", e)
            # Финальный вердикт сверки названия карточки с названием из реестра
            _apply_ozon_verdicts(rows)
            try:
                from main_v39 import emit_progress as _emit
                _emit("registry", n_with_reg, n_with_reg)
            except Exception:
                pass
            print(f"[Ozon-Playwright] реестры обработаны за {time.time()-t2:.1f}с", flush=True)
            diag["rows_with_registry"] = n_with_reg
        else:
            print("[Ozon-Playwright] реестровых ссылок в карточках не найдено", flush=True)
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
