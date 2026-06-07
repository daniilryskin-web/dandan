"""
wb_enhanced.py — Надёжный сборщик данных продавца и плашки «Оригинал» для Wildberries.

Версия: 1.0.0
Совместимость: Python 3.9+
Зависимости: aiohttp, bs4 (beautifulsoup4)
Опционально: curl_cffi (для TLS-фингерпринт обхода), playwright (для JS-рендеринга)

Архитектура источников данных:
  1) card.wb.ru/cards/detail   — главный, supplier из data.products[].supplier
  2) basket-NN.wbbasket.ru/.../info/sellers.json — статика
  3) Публичный HTML https://www.wildberries.ru/catalog/{nm_id}/detail.aspx

Использование (библиотека):
    from wb_enhanced import WBEnhancedClient
    client = WBEnhancedClient()
    results = await client.fetch_seller_and_original_batch(nm_ids, workers=20)

Использование (CLI):
    python wb_enhanced.py --nm 68789915,123456789 --workers 5
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import logging
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Опциональные зависимости
# ---------------------------------------------------------------------------
try:
    import aiohttp
    _AIOHTTP_OK = True
except ImportError:
    _AIOHTTP_OK = False
    aiohttp = None  # type: ignore[assignment]

try:
    from bs4 import BeautifulSoup
    _BS4_OK = True
except ImportError:
    _BS4_OK = False
    BeautifulSoup = None  # type: ignore[assignment]

try:
    from curl_cffi.requests import AsyncSession as CurlAsyncSession
    _CURL_CFFI_OK = True
except ImportError:
    _CURL_CFFI_OK = False
    CurlAsyncSession = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Логирование — формат совместим с main_v39.py для GUI
# ---------------------------------------------------------------------------
_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATE_FORMAT = "%H:%M:%S"

log = logging.getLogger("wb_enhanced")
if not log.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------

#: Дефолтный User-Agent (Chrome 136 Windows)
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/136.0.6478.127 Safari/537.36"
)

#: Мобильный User-Agent (iPhone)
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.4 Mobile/15E148 Safari/604.1"
)

#: Заголовки для card.wb.ru
CARD_API_HEADERS: Dict[str, str] = {
    "User-Agent": DEFAULT_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.wildberries.ru",
    "Referer": "https://www.wildberries.ru/",
    "Cache-Control": "no-cache",
}

#: Заголовки для публичного HTML
HTML_HEADERS: Dict[str, str] = {
    "User-Agent": DEFAULT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.5",
    "Referer": "https://www.wildberries.ru/",
    "Cache-Control": "no-cache",
}

#: Шаблоны URL для card detail API (v4 первым, v2 как fallback)
DETAIL_API_TEMPLATES: List[str] = [
    "https://card.wb.ru/cards/v4/detail?appType=0&curr=rub&dest={dest}&spp=30&nm={nms}",
    "https://card.wb.ru/cards/v2/detail?appType=0&curr=rub&dest={dest}&spp=30&nm={nms}",
    "https://card.wb.ru/cards/detail?appType=0&curr=rub&dest={dest}&spp=30&nm={nms}",
]

#: Регион по умолчанию — Москва
DEFAULT_DEST = -1257786

#: Доменные зоны WB для HTML-проверки оригинала (в порядке приоритета).
#: v27.7: по умолчанию только "ru" — это главный регион и единственный
#: авторитетный источник плашки «Оригинал». Прежние 4 домена (ru/by/kg/ge)
#: давали до 4 тяжёлых HTML-загрузок на КАЖДУЮ карточку и были основной
#: причиной медленной работы WB. by/kg/ge остаются доступны как опция.
DEFAULT_HTML_DOMAINS = ["ru"]

#: Максимум nm_id в одном запросе к card.wb.ru
BATCH_CHUNK = 100

#: Максимум попыток для каждого запроса
MAX_RETRIES = 3

#: Начальная задержка перед retry (сек)
RETRY_BASE_DELAY = 0.5

#: Таймаут одного HTTP-запроса (сек)
REQUEST_TIMEOUT = 20.0

#: Таймаут подключения
CONNECT_TIMEOUT = 8.0

#: Маркер «не найдено» для seller_name
SELLER_UNKNOWN = ""


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def norm_text(s: str) -> str:
    """Нормализация строки: lowercase, замена ё→е, схлопывание пробелов."""
    return re.sub(r"\s+", " ", (s or "").replace("ё", "е").lower()).strip()


def safe_int(v: Any, default: int = 0) -> int:
    """Безопасное приведение к int."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def wb_basket_by_volume(vol: int) -> int:
    """
    Определяет номер basket-хоста WB по значению VOL (nm_id // 100_000).

    Таблица диапазонов VOL → basket (расширенная до basket 30):
      0-143: 01, 144-287: 02, 288-431: 03, 432-719: 04, 720-1007: 05,
      1008-1061: 06, 1062-1115: 07, 1116-1169: 08, 1170-1313: 09, 1314-1601: 10,
      1602-1655: 11, 1656-1919: 12, 1920-2045: 13, 2046-2189: 14, 2190-2405: 15,
      2406-2621: 16, 2622-2837: 17, 2838-3053: 18, 3054-3269: 19, 3270-3485: 20,
      3486-3701: 21, 3702-3917: 22, 3918-4133: 23, 4134-4349: 24, 4350-4565: 25,
      4566-4781: 26, 4782-4997: 27, 4998-5213: 28, 5214-5429: 29, 5430+: 30
    """
    _BASKET_RANGES: List[Tuple[int, int]] = [
        (143, 1), (287, 2), (431, 3), (719, 4), (1007, 5),
        (1061, 6), (1115, 7), (1169, 8), (1313, 9), (1601, 10),
        (1655, 11), (1919, 12), (2045, 13), (2189, 14), (2405, 15),
        (2621, 16), (2837, 17), (3053, 18), (3269, 19), (3485, 20),
        (3701, 21), (3917, 22), (4133, 23), (4349, 24), (4565, 25),
        (4781, 26), (4997, 27), (5213, 28), (5429, 29), (10**9, 30),
    ]
    for max_vol, basket in _BASKET_RANGES:
        if vol <= max_vol:
            return basket
    return 30


def basket_seller_url(nm_id: int) -> str:
    """
    Строит URL для sellers.json на static basket-хосте WB.

    Пример для артикула 68789915:
      vol = 687, part = 68789, basket = 05
      → https://basket-05.wbbasket.ru/vol687/part68789/68789915/info/sellers.json
    """
    vol = nm_id // 100_000
    part = nm_id // 1_000
    basket = wb_basket_by_volume(vol)
    return (
        f"https://basket-{basket:02d}.wbbasket.ru"
        f"/vol{vol}/part{part}/{nm_id}/info/sellers.json"
    )


def basket_card_json_url(nm_id: int) -> str:
    """
    Строит URL для card.json на static basket-хосте WB.

    Пример для артикула 208285191:
      vol = 2082, part = 208285, basket = 14
      → https://basket-14.wbbasket.ru/vol2082/part208285/208285191/info/ru/card.json
    """
    vol = nm_id // 100_000
    part = nm_id // 1_000
    basket = wb_basket_by_volume(vol)
    return (
        f"https://basket-{basket:02d}.wbbasket.ru"
        f"/vol{vol}/part{part}/{nm_id}/info/ru/card.json"
    )


def clean_seller_name(s: Any) -> str:
    """
    Финальная защита: не записывать служебные метки вместо имени продавца.

    Удаляет:
    - Обёртки «Продавец: ...»
    - Хвосты «о продавце / перейти к продавцу / задать вопрос»
    - Известные служебные значения (wb, seller, корзина и т.д.)
    - Строки длиной < 2 или > 120 символов
    - Строки из одних цифр/символов

    Возвращает очищенную строку или '' если значение не годится.
    """
    t = re.sub(r"\s+", " ", str(s or "")).strip().strip('"\'«»')
    t = re.sub(r"^продавец\s*[:\-–—]?\s*", "", t, flags=re.I).strip()
    t = re.sub(
        r"\s+(о продавце|перейти к продавцу|задать вопрос).*$", "", t, flags=re.I
    ).strip()
    tl = norm_text(t)
    _BAD_EXACT = {
        "", "продавец", "о продавце", "перейти к продавцу", "задать вопрос",
        "seller", "товары продавца", "магазин продавца", "рейтинг продавца",
        "wildberries продавец", "склад wb", "wb", "не указано",
    }
    if tl in _BAD_EXACT:
        return ""
    if len(t) < 2 or len(t) > 120:
        return ""
    if re.match(
        r"^(доставка|возврат|оплата|покупают|реклама|спонсорский|поставил|доставит|отзыв|оценк)",
        tl,
        flags=re.I,
    ):
        return ""
    if re.fullmatch(r"[0-9\s.,₽%+\-–—]+", t):
        return ""
    return t


def deep_first_text(
    obj: Any,
    keys: Tuple[str, ...],
    max_depth: int = 4,
) -> str:
    """
    Рекурсивно ищет первое строковое значение по списку ключей в словаре.

    Используется для извлечения имени из вложенных структур типа
    {'seller': {'name': 'Shop ABC', ...}}.
    """
    best: List[str] = []

    def walk(node: Any, depth: int) -> None:
        if best or depth > max_depth:
            return
        if isinstance(node, dict):
            for k in keys:
                v = node.get(k)
                if isinstance(v, str) and v.strip():
                    best.append(v.strip())
                    return
            for v in node.values():
                if isinstance(v, (dict, list)):
                    walk(v, depth + 1)
                    if best:
                        return
        elif isinstance(node, list):
            for item in node:
                walk(item, depth + 1)
                if best:
                    return

    walk(obj, 0)
    return best[0].strip() if best else ""


def seller_from_product_json(p: Dict[str, Any]) -> str:
    """
    Извлекает имя продавца/поставщика из объекта продукта (data.products[]).

    Порядок приоритета:
    1. Прямые строковые поля: supplierName, sellerName, supplier, seller
    2. Вложенные словари supplierInfo / sellerInfo / merchant через deep_first_text
    3. Рекурсивный поиск по полям supplierName / sellerName на глубину 6
    """
    # 1) Прямые строковые поля
    for key in ("supplierName", "sellerName", "supplier", "seller"):
        v = p.get(key)
        if isinstance(v, str):
            cleaned = clean_seller_name(v)
            if cleaned:
                return cleaned
    # 2) Вложенные словари
    for key in ("supplierInfo", "sellerInfo", "merchant", "supplier", "seller"):
        node = p.get(key)
        if isinstance(node, dict):
            txt = deep_first_text(
                node, ("name", "supplierName", "sellerName", "title"), 4
            )
            cleaned = clean_seller_name(txt)
            if cleaned:
                return cleaned
    # 3) Рекурсивный поиск
    txt = deep_first_text(p, ("supplierName", "sellerName"), 6)
    return clean_seller_name(txt)


def recursive_find_products(obj: Any) -> List[Dict[str, Any]]:
    """
    Рекурсивно находит список products в произвольно вложенной структуре JSON.

    WB API иногда оборачивает data.products в нестандартные ключи — этот
    метод справляется с любой глубиной вложенности.
    """
    res: List[Dict[str, Any]] = []
    if isinstance(obj, dict):
        if isinstance(obj.get("products"), list):
            for p in obj["products"]:
                if isinstance(p, dict) and (
                    "id" in p or "nmId" in p or "nm_id" in p
                ):
                    res.append(p)
        for v in obj.values():
            if isinstance(v, (dict, list)):
                res.extend(recursive_find_products(v))
    elif isinstance(obj, list):
        for x in obj:
            if isinstance(x, (dict, list)):
                res.extend(recursive_find_products(x))
    return res


def strip_html_to_text(raw: str) -> str:
    """
    Грубо преобразует HTML WB/SEO-страницы в текст для поиска бейджа «Оригинал».

    Удаляет <script>, <style>, все теги. Схлопывает пробелы/переводы строк.
    """
    txt = html.unescape(str(raw or ""))
    txt = re.sub(r"<script\b[\s\S]*?</script>", " ", txt, flags=re.I)
    txt = re.sub(r"<style\b[\s\S]*?</style>", " ", txt, flags=re.I)
    txt = re.sub(r"<[^>]+>", "\n", txt)
    txt = re.sub(r"[ \t\r\f\v]+", " ", txt)
    txt = re.sub(r"\n\s*\n+", "\n", txt)
    return txt.strip()


# ---------------------------------------------------------------------------
# Детектор плашки «Оригинал» по публичному HTML
# ---------------------------------------------------------------------------

def public_html_has_original_badge(
    raw: str,
    nm_id: int,
    brand: str = "",
    product_name: str = "",
) -> Tuple[bool, str]:
    """
    Проверяет наличие плашки «Оригинал» в публичном HTML WB.

    Паттерны поиска (в порядке приоритета):
    1. SEO-паттерн: «Оригинал. Характеристики ... Артикул ...»
    2. Отдельная строка «Оригинал» / «original» с товарным контекстом рядом
    3. DOM-маркеры: originalmark / OriginalMark / productHeaderBadges + «Оригинал»
    4. JSON-state / React: «originalmark», «productheaderbadges», «метка оригинал»

    Параметры:
        raw          : сырой HTML
        nm_id        : артикул товара (для верификации что страница правильная)
        brand        : бренд товара (опционально)
        product_name : название товара (опционально)

    Возвращает:
        (is_original: bool, reason: str)
    """
    if not raw:
        return False, "empty_html"

    raw_dec = html.unescape(str(raw))
    raw_low = norm_text(raw_dec)

    text = strip_html_to_text(raw_dec)
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.splitlines()]
    lines = [x for x in lines if x]
    low_lines = [norm_text(x) for x in lines]

    nm_str = str(nm_id) if nm_id else ""
    brand_norm = norm_text(brand or "")
    name_norm = norm_text(product_name or "")

    # Верификация: страница должна быть именно об этом товаре
    product_evidence = False
    if nm_str and nm_str in raw_dec:
        product_evidence = True
    if brand_norm and len(brand_norm) >= 2 and brand_norm in raw_low:
        product_evidence = True
    if name_norm and len(name_norm) >= 5 and name_norm[:80] in raw_low:
        product_evidence = True
    if not product_evidence:
        return False, "no_product_evidence"

    # 1) Самый надёжный SEO-паттерн WB:
    #    «Оригинал. Характеристики ... Артикул ...»
    compact = norm_text(text)
    _SEO_PAT = re.compile(
        r"(?:^|\s)оригинал\s*[\.·•|/\-]?\s*"
        r"(?:характеристики|описание|артикул|цвет|состав|пол|страна\s+производства)"
        r"(?:\s|$)",
        flags=re.I,
    )
    if _SEO_PAT.search(compact):
        return True, "html_original_before_specs"

    # 2) Отдельная строка «Оригинал» / «original» с товарным контекстом
    _ORIG_EXACT = re.compile(r"^(?:оригинал|original)$")
    _CTX_PAT = re.compile(
        r"артикул|характеристики|описание|цвет|состав|оценк|вопрос|купить|корзин|рейтинг",
        flags=re.I,
    )
    for i, l in enumerate(low_lines[:300]):
        if _ORIG_EXACT.fullmatch(l):
            ctx_start = max(0, i - 12)
            ctx_end = min(len(low_lines), i + 18)
            ctx = " ".join(low_lines[ctx_start:ctx_end])
            if _CTX_PAT.search(ctx):
                return True, f"html_exact_line_i={i}"

    # 3) DOM-маркеры в HTML (до стрипа тегов) — WB использует CSS-классы
    _DOM_MARKERS = re.compile(
        r"originalmark|productheaderbadges|метк[аи]?\s+оригинал",
        flags=re.I,
    )
    if _DOM_MARKERS.search(raw_low):
        return True, "html_dom_marker"

    # 4) JSON-state / React: «originalmark» или «OriginalMark» в сырых данных
    #    WB иногда встраивает JSON в <script> с window.__NUXT__ или __NEXT_DATA__
    _JSON_STATE_PAT = re.compile(
        r'"(?:originalMark|original_mark|originalBadge|isOriginal|hasOriginalMark)"\s*:\s*true',
        flags=re.I,
    )
    if _JSON_STATE_PAT.search(raw_dec):
        return True, "html_json_state_true"

    # 5) «Оригинал» рядом с артикулом (короткая дистанция в тексте)
    if nm_str:
        nm_idx = compact.find(nm_str)
        if nm_idx != -1:
            window = compact[max(0, nm_idx - 400): nm_idx + 400]
            if re.search(r"(?:^|\s)оригинал(?:\s|$)", window, flags=re.I):
                return True, "html_original_near_article"

    return False, "html_not_found"


# ---------------------------------------------------------------------------
# Основной клиент
# ---------------------------------------------------------------------------

class WBEnhancedClient:
    """
    Надёжный клиент для сбора данных продавца и плашки «Оригинал» с WB.

    Источники данных (порядок попыток):
    1) card.wb.ru/cards/detail (главный, supplier из data.products[].supplier)
    2) basket-NN.wbbasket.ru/.../info/sellers.json (статика)
    3) Публичный HTML https://www.wildberries.ru/catalog/{nm_id}/detail.aspx

    Параметры:
        dest              : код региона (dest), по умолчанию -1257786 (Москва)
        html_domains      : список доменных зон WB для HTML-fallback
        request_timeout   : таймаут запроса в секундах
        connect_timeout   : таймаут подключения в секундах
        max_retries       : максимум повторных попыток
        retry_base_delay  : начальная задержка перед retry (сек)
        use_curl_cffi     : использовать curl_cffi для TLS-обхода (если доступно)
    """

    def __init__(
        self,
        dest: int = DEFAULT_DEST,
        html_domains: Optional[List[str]] = None,
        request_timeout: float = REQUEST_TIMEOUT,
        connect_timeout: float = CONNECT_TIMEOUT,
        max_retries: int = MAX_RETRIES,
        retry_base_delay: float = RETRY_BASE_DELAY,
        use_curl_cffi: bool = True,
    ) -> None:
        self.dest = dest
        self.html_domains: List[str] = html_domains or DEFAULT_HTML_DOMAINS
        self.request_timeout = request_timeout
        self.connect_timeout = connect_timeout
        self.max_retries = max_retries
        self.retry_base_delay = retry_base_delay
        self.use_curl_cffi = use_curl_cffi and _CURL_CFFI_OK

    # ------------------------------------------------------------------
    # Внутренние HTTP-утилиты
    # ------------------------------------------------------------------

    async def _get_json_with_retry(
        self,
        session: "aiohttp.ClientSession",
        url: str,
        headers: Optional[Dict[str, str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Выполняет GET-запрос с экспоненциальным retry, возвращает JSON или None.

        Экспоненциальная задержка: base * 2^attempt (0.5s, 1.0s, 2.0s ...).
        """
        last_exc: Optional[Exception] = None
        timeout_obj = aiohttp.ClientTimeout(
            total=self.request_timeout,
            connect=self.connect_timeout,
        )
        for attempt in range(self.max_retries):
            if attempt > 0:
                delay = self.retry_base_delay * (2 ** (attempt - 1))
                await asyncio.sleep(delay)
            try:
                req_headers = headers or CARD_API_HEADERS
                async with session.get(
                    url, headers=req_headers, timeout=timeout_obj
                ) as resp:
                    if resp.status == 429:
                        log.warning("Получен 429 (rate limit) для %s, ждём...", url)
                        await asyncio.sleep(self.retry_base_delay * (3 ** attempt))
                        continue
                    if resp.status == 403:
                        log.warning("403 Forbidden для %s", url)
                        return None
                    if resp.status == 404:
                        return None
                    if resp.status != 200:
                        log.debug("HTTP %d для %s", resp.status, url)
                        continue
                    text = await resp.text(errors="replace")
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError as e:
                        log.debug("JSONDecodeError для %s: %s", url, e)
                        return None
            except asyncio.TimeoutError as e:
                last_exc = e
                log.debug("Timeout (попытка %d) для %s", attempt + 1, url)
            except Exception as e:
                last_exc = e
                log.debug("Ошибка (попытка %d) для %s: %s", attempt + 1, url, e)
        if last_exc:
            log.warning("Все %d попытки исчерпаны для %s: %s", self.max_retries, url, last_exc)
        return None

    async def _get_html_with_retry(
        self,
        session: "aiohttp.ClientSession",
        url: str,
    ) -> Tuple[Optional[str], int]:
        """
        Выполняет GET-запрос, возвращает (html_text, status_code) или (None, status).

        Использует HTML_HEADERS. Статус 200 — успех, остальное — ошибка.
        """
        last_exc: Optional[Exception] = None
        timeout_obj = aiohttp.ClientTimeout(
            total=self.request_timeout,
            connect=self.connect_timeout,
        )
        for attempt in range(self.max_retries):
            if attempt > 0:
                delay = self.retry_base_delay * (2 ** (attempt - 1))
                await asyncio.sleep(delay)
            try:
                async with session.get(
                    url,
                    headers=HTML_HEADERS,
                    timeout=timeout_obj,
                    allow_redirects=True,
                ) as resp:
                    status = int(resp.status)
                    if status == 429:
                        await asyncio.sleep(self.retry_base_delay * (3 ** attempt))
                        continue
                    if status not in (200,):
                        return None, status
                    text = await resp.text(errors="replace")
                    return text, status
            except asyncio.TimeoutError as e:
                last_exc = e
                log.debug("HTML timeout (попытка %d) для %s", attempt + 1, url)
            except Exception as e:
                last_exc = e
                log.debug("HTML ошибка (попытка %d) для %s: %s", attempt + 1, url, e)
        if last_exc:
            log.debug("Все %d HTML попытки для %s: %s", self.max_retries, url, last_exc)
        return None, 0

    def _make_aiohttp_session(self, workers: int) -> "aiohttp.ClientSession":
        """Создаёт aiohttp сессию с правильными лимитами коннектора."""
        connector = aiohttp.TCPConnector(
            limit=workers * 4,
            ttl_dns_cache=300,
            ssl=False,
        )
        return aiohttp.ClientSession(connector=connector)

    # ------------------------------------------------------------------
    # Источник 1: card.wb.ru/cards/detail
    # ------------------------------------------------------------------

    async def _fetch_card_detail(
        self,
        nm_ids: List[int],
        session: "aiohttp.ClientSession",
    ) -> List[Dict[str, Any]]:
        """
        Запрашивает card.wb.ru/cards/detail для списка nm_id (до 100 за раз).

        Пробует шаблоны из DETAIL_API_TEMPLATES (v4 → v2 → legacy).
        Возвращает список объектов products[] из ответа.
        """
        if not nm_ids:
            return []
        nms = ";".join(map(str, nm_ids))
        for tmpl in DETAIL_API_TEMPLATES:
            url = tmpl.format(dest=self.dest, nms=nms)
            data = await self._get_json_with_retry(session, url)
            if data is None:
                log.debug("Нет ответа от %s", url)
                continue
            products = recursive_find_products(data)
            if products:
                log.debug("card.wb.ru вернул %d продуктов (%s)", len(products), url)
                return products
        log.debug("card.wb.ru не вернул продуктов для nm: %s", nms[:80])
        return []

    # ------------------------------------------------------------------
    # Источник 2: basket-NN sellers.json
    # ------------------------------------------------------------------

    async def _fetch_basket_seller(
        self,
        nm_id: int,
        session: "aiohttp.ClientSession",
    ) -> str:
        """
        Запрашивает статический sellers.json на basket-хосте WB.

        Структура ответа sellers.json (типичная):
        {
          "trademark": "Brand Name",
          "supplier": "ООО «Торговый Дом»",
          ...
        }
        или массив:
        [{"id": 123, "name": "Shop Name", ...}]

        Возвращает чистое имя продавца или пустую строку.
        """
        url = basket_seller_url(nm_id)
        data = await self._get_json_with_retry(session, url, headers=CARD_API_HEADERS)
        if data is None:
            return ""

        # Структура может быть словарём или массивом
        if isinstance(data, list):
            # Берём первый элемент с именем
            for item in data:
                if isinstance(item, dict):
                    for k in ("name", "supplierName", "sellerName", "trademark", "supplier"):
                        v = item.get(k)
                        cleaned = clean_seller_name(v)
                        if cleaned:
                            return cleaned
        elif isinstance(data, dict):
            # Ищем среди прямых полей
            for k in ("name", "supplier", "supplierName", "sellerName", "trademark"):
                v = data.get(k)
                cleaned = clean_seller_name(v)
                if cleaned:
                    return cleaned
            # Вложенные структуры
            for subkey in ("seller", "supplier", "merchant", "brand"):
                sub = data.get(subkey)
                if isinstance(sub, dict):
                    txt = deep_first_text(
                        sub, ("name", "supplierName", "sellerName", "title"), 3
                    )
                    cleaned = clean_seller_name(txt)
                    if cleaned:
                        return cleaned

        log.debug("sellers.json для nm=%d не содержит имени продавца", nm_id)
        return ""

    # ------------------------------------------------------------------
    # Источник 3: basket-NN info/ru/card.json (дополнительный)
    # ------------------------------------------------------------------

    async def _fetch_basket_card_json_seller(
        self,
        nm_id: int,
        session: "aiohttp.ClientSession",
    ) -> str:
        """
        Пробует получить имя продавца из basket card.json.

        card.json содержит расширенное описание товара и характеристики.
        Поле продавца там менее надёжно, но иногда есть.
        """
        url = basket_card_json_url(nm_id)
        data = await self._get_json_with_retry(session, url, headers=CARD_API_HEADERS)
        if data is None:
            return ""
        if isinstance(data, dict):
            for k in ("supplier", "supplierName", "sellerName", "seller", "trademark"):
                v = data.get(k)
                cleaned = clean_seller_name(v)
                if cleaned:
                    return cleaned
        return ""

    # ------------------------------------------------------------------
    # Источник 3: Публичный HTML — детектор оригинала
    # ------------------------------------------------------------------

    async def _check_original_via_html(
        self,
        nm_id: int,
        session: "aiohttp.ClientSession",
        brand: str = "",
        product_name: str = "",
    ) -> Tuple[bool, str]:
        """
        Проверяет плашку «Оригинал» по публичному HTML WB.

        Перебирает домены из self.html_domains в порядке приоритета.
        Возвращает (True, reason) при первом совпадении.
        """
        errors: List[str] = []
        for domain in self.html_domains:
            # Строим полный hostname
            if "wildberries." in domain:
                host = domain
            else:
                host = f"www.wildberries.{domain}"
            url = f"https://{host}/catalog/{nm_id}/detail.aspx"
            raw_html, status = await self._get_html_with_retry(session, url)
            if raw_html is None:
                errors.append(f"{status}:{url}")
                continue
            ok, reason = public_html_has_original_badge(
                raw_html, nm_id, brand=brand, product_name=product_name
            )
            if ok:
                return True, f"{reason}:{url}"
            errors.append(f"no:{reason}:{url}")
        return False, ";".join(errors[:4]) or "html_not_found"

    # ------------------------------------------------------------------
    # viewFlags анализ (TODO: требует эмпирического подтверждения)
    # ------------------------------------------------------------------

    @staticmethod
    def _check_view_flags_original(view_flags: int) -> Tuple[bool, str]:
        """
        TODO: Эмпирически установить битовый флаг «Оригинал» в viewFlags.

        В ответе card.wb.ru поле viewFlags является битовой маской.
        Для nm_id=68789915 (Diamod Shop) viewFlags=1679377.
        Необходимо сравнить несколько товаров с плашкой и без неё
        для выявления конкретного бита.

        Текущее значение: не определён, метод всегда возвращает (False, "viewFlags_unknown").
        """
        # TODO: После сбора эмпирических данных раскомментировать:
        # ORIGINAL_BIT = 0x????????  # определить из анализа
        # if view_flags & ORIGINAL_BIT:
        #     return True, f"viewFlags_bit_0x{ORIGINAL_BIT:X}"
        return False, "viewFlags_unknown"

    # ------------------------------------------------------------------
    # Публичный API: fetch_seller_for_nm
    # ------------------------------------------------------------------

    async def fetch_seller_for_nm(self, nm_id: int) -> Optional[str]:
        """
        Получает имя продавца для одного nm_id.

        Порядок источников:
        1) card.wb.ru/cards/detail → поле supplier
        2) basket-NN/info/sellers.json → статика

        Возвращает строку с именем или None если не найдено.
        """
        if not _AIOHTTP_OK:
            raise ImportError("Требуется aiohttp: pip install aiohttp")
        async with self._make_aiohttp_session(workers=2) as session:
            # 1) card.wb.ru
            products = await self._fetch_card_detail([nm_id], session)
            for p in products:
                nm = safe_int(p.get("id") or p.get("nmId") or p.get("nm_id"))
                if nm == nm_id:
                    seller = seller_from_product_json(p)
                    if seller:
                        return seller
            # 2) sellers.json
            seller = await self._fetch_basket_seller(nm_id, session)
            if seller:
                return seller
        return None

    # ------------------------------------------------------------------
    # Публичный API: fetch_seller_batch
    # ------------------------------------------------------------------

    async def fetch_seller_batch(
        self,
        nm_ids: List[int],
        workers: int = 10,
    ) -> Dict[int, str]:
        """
        Массово получает имена продавцов для списка nm_id.

        Работает группами по BATCH_CHUNK (100) nm_id через card.wb.ru,
        для карточек без продавца — fallback на sellers.json (параллельно).

        Параметры:
            nm_ids  : список артикулов WB
            workers : количество параллельных задач

        Возвращает:
            {nm_id: seller_name} — пустая строка если продавец не найден.
        """
        if not _AIOHTTP_OK:
            raise ImportError("Требуется aiohttp: pip install aiohttp")
        if not nm_ids:
            return {}

        result: Dict[int, str] = {nm: "" for nm in nm_ids}
        sem = asyncio.Semaphore(workers)
        t0 = time.time()

        chunks = [
            nm_ids[i: i + BATCH_CHUNK]
            for i in range(0, len(nm_ids), BATCH_CHUNK)
        ]
        log.info(
            "fetch_seller_batch: %d артикулов, %d чанков по %d",
            len(nm_ids), len(chunks), BATCH_CHUNK,
        )

        async with self._make_aiohttp_session(workers) as session:

            async def process_chunk(chunk: List[int]) -> None:
                async with sem:
                    products = await self._fetch_card_detail(chunk, session)
                for p in products:
                    nm = safe_int(p.get("id") or p.get("nmId") or p.get("nm_id"))
                    if nm in result:
                        seller = seller_from_product_json(p)
                        if seller:
                            result[nm] = seller

            # Запуск батчей
            chunk_tasks = [asyncio.create_task(process_chunk(c)) for c in chunks]
            await asyncio.gather(*chunk_tasks, return_exceptions=True)

            # Fallback: sellers.json для тех, у кого не нашли
            missing = [nm for nm, s in result.items() if not s]
            if missing:
                log.info(
                    "fetch_seller_batch: %d артикулов без продавца, fallback на sellers.json",
                    len(missing),
                )

                async def fallback_one(nm: int) -> None:
                    async with sem:
                        seller = await self._fetch_basket_seller(nm, session)
                        if seller:
                            result[nm] = seller

                fb_tasks = [asyncio.create_task(fallback_one(nm)) for nm in missing]
                await asyncio.gather(*fb_tasks, return_exceptions=True)

        filled = sum(1 for s in result.values() if s)
        log.info(
            "fetch_seller_batch: заполнено %d/%d за %.1fс",
            filled, len(nm_ids), time.time() - t0,
        )
        return result

    # ------------------------------------------------------------------
    # Публичный API: check_original_badge
    # ------------------------------------------------------------------

    async def check_original_badge(
        self,
        nm_id: int,
        brand: str = "",
        product_name: str = "",
    ) -> Tuple[bool, str]:
        """
        Проверяет наличие плашки «Оригинал» для nm_id тремя методами:

        1) Поле viewFlags в ответе card.wb.ru — анализ битовой маски
           (TODO: требует эмпирического подтверждения конкретного бита)
        2) Публичный HTML страницы товара — поиск паттернов:
           - SEO-паттерн «Оригинал. Характеристики...Артикул...»
           - Отдельная строка «Оригинал» / «original» с контекстом
           - DOM-маркеры: originalmark / OriginalMark / productHeaderBadges
           - JSON-state: hasOriginalMark / isOriginal = true
        3) Basket card.json — поиск маркеров в расширенном описании

        Параметры:
            nm_id        : артикул товара
            brand        : бренд (опционально, улучшает детектор HTML)
            product_name : название товара (опционально)

        Возвращает:
            (is_original: bool, reason: str)
        """
        if not _AIOHTTP_OK:
            raise ImportError("Требуется aiohttp: pip install aiohttp")

        async with self._make_aiohttp_session(workers=3) as session:
            # 1) viewFlags из card.wb.ru
            products = await self._fetch_card_detail([nm_id], session)
            for p in products:
                nm = safe_int(p.get("id") or p.get("nmId") or p.get("nm_id"))
                if nm == nm_id:
                    vf = safe_int(p.get("viewFlags", 0))
                    if vf:
                        ok, reason = self._check_view_flags_original(vf)
                        if ok:
                            return True, reason
                    # Попутно берём бренд/название если не переданы
                    if not brand:
                        brand = str(p.get("brand") or "")
                    if not product_name:
                        product_name = str(p.get("name") or "")

            # 2) Публичный HTML (основной надёжный метод)
            ok, reason = await self._check_original_via_html(
                nm_id, session, brand=brand, product_name=product_name
            )
            if ok:
                return True, reason

            # 3) Basket card.json — последний шанс
            ok_card, reason_card = await self._check_original_from_card_json(
                nm_id, session
            )
            if ok_card:
                return True, reason_card

        return False, reason

    async def _check_original_from_card_json(
        self,
        nm_id: int,
        session: "aiohttp.ClientSession",
    ) -> Tuple[bool, str]:
        """
        Ищет маркер «Оригинал» в basket card.json.

        card.json содержит полный текст характеристик товара.
        Ищем поля «Оригинал» или «originalBadge»/«isOriginal» в JSON.
        """
        url = basket_card_json_url(nm_id)
        data = await self._get_json_with_retry(session, url, headers=CARD_API_HEADERS)
        if data is None:
            return False, "card_json_unavailable"

        # Ищем признаки в полях
        if isinstance(data, dict):
            # Прямые boolean-поля
            for k in ("isOriginal", "hasOriginalMark", "originalBadge", "originalMark"):
                v = data.get(k)
                if v is True or (isinstance(v, str) and norm_text(v) in ("true", "1", "да")):
                    return True, f"card_json_field_{k}"
            # Поиск в характеристиках
            options = data.get("options") or data.get("grouped_options") or []
            if isinstance(options, list):
                for opt in options:
                    if isinstance(opt, dict):
                        name = norm_text(str(opt.get("name") or ""))
                        value = norm_text(str(opt.get("value") or ""))
                        if "оригинал" in name or "оригинал" in value:
                            return True, f"card_json_option:{name}={value}"

        # Текстовый поиск в сериализованном JSON
        raw_json = json.dumps(data, ensure_ascii=False) if data else ""
        if re.search(r'"(?:isOriginal|hasOriginalMark|originalBadge)"\s*:\s*true', raw_json, flags=re.I):
            return True, "card_json_serialized_true"

        return False, "card_json_not_found"

    # ------------------------------------------------------------------
    # Публичный API: fetch_seller_and_original_batch
    # ------------------------------------------------------------------

    async def fetch_seller_and_original_batch(
        self,
        nm_ids: List[int],
        workers: int = 10,
    ) -> Dict[int, Dict[str, Any]]:
        """
        Массово собирает продавца и плашку «Оригинал» для списка nm_id.

        Алгоритм:
        1. Группами по BATCH_CHUNK запрашивает card.wb.ru/cards/detail
        2. Для каждого где supplier пуст — fallback на sellers.json
        3. Параллельно для всех — проверка плашки «Оригинал» через HTML
        4. Прогресс в stdout: «WB enrich: N/M»

        Параметры:
            nm_ids  : список артикулов WB
            workers : количество параллельных задач

        Возвращает:
            {nm_id: {
                'seller': str,       # имя продавца (или '')
                'is_original': bool, # есть плашка «Оригинал»
                'reason': str,       # источник/причина результата
            }}
        """
        if not _AIOHTTP_OK:
            raise ImportError("Требуется aiohttp: pip install aiohttp")
        if not nm_ids:
            return {}

        t0 = time.time()
        total = len(nm_ids)
        result: Dict[int, Dict[str, Any]] = {
            nm: {"seller": "", "is_original": False, "reason": "pending"}
            for nm in nm_ids
        }
        # Кэш бренда/названия из card.wb.ru для улучшения HTML-детектора
        _meta: Dict[int, Dict[str, str]] = {}

        sem = asyncio.Semaphore(workers)
        done_counter: Dict[str, int] = {"n": 0}

        chunks = [
            nm_ids[i: i + BATCH_CHUNK]
            for i in range(0, len(nm_ids), BATCH_CHUNK)
        ]

        log.info(
            "fetch_seller_and_original_batch: %d артикулов, %d чанков, %d workers",
            total, len(chunks), workers,
        )

        async with self._make_aiohttp_session(workers) as session:

            # --- Шаг 1: Массовый запрос card.wb.ru ---
            async def process_card_chunk(chunk: List[int]) -> None:
                async with sem:
                    products = await self._fetch_card_detail(chunk, session)
                for p in products:
                    nm = safe_int(p.get("id") or p.get("nmId") or p.get("nm_id"))
                    if nm not in result:
                        continue
                    seller = seller_from_product_json(p)
                    if seller:
                        result[nm]["seller"] = seller
                    # Кэшируем метаданные для HTML-детектора
                    _meta[nm] = {
                        "brand": str(p.get("brand") or ""),
                        "name": str(p.get("name") or ""),
                    }

            card_tasks = [asyncio.create_task(process_card_chunk(c)) for c in chunks]
            await asyncio.gather(*card_tasks, return_exceptions=True)

            # --- Шаг 2: Fallback sellers.json для пустых ---
            missing_sellers = [nm for nm in nm_ids if not result[nm]["seller"]]
            if missing_sellers:
                log.info(
                    "Fallback sellers.json для %d артикулов", len(missing_sellers)
                )

                async def fallback_seller(nm: int) -> None:
                    async with sem:
                        seller = await self._fetch_basket_seller(nm, session)
                        if seller:
                            result[nm]["seller"] = seller

                fb_tasks = [
                    asyncio.create_task(fallback_seller(nm))
                    for nm in missing_sellers
                ]
                await asyncio.gather(*fb_tasks, return_exceptions=True)

            # --- Шаг 3: Параллельная проверка «Оригинал» ---
            async def check_original_one(nm: int) -> None:
                async with sem:
                    meta = _meta.get(nm, {})
                    brand = meta.get("brand", "")
                    name = meta.get("name", "")

                    # viewFlags — из ранее загруженных данных (не повторяем запрос)
                    # HTML-проверка (основной надёжный метод)
                    ok, reason = await self._check_original_via_html(
                        nm, session, brand=brand, product_name=name
                    )
                    if not ok:
                        # Попытка через basket card.json
                        ok, reason = await self._check_original_from_card_json(
                            nm, session
                        )

                    result[nm]["is_original"] = ok
                    result[nm]["reason"] = reason

                done_counter["n"] += 1
                if done_counter["n"] % max(1, total // 20) == 0 or done_counter["n"] == total:
                    print(f"WB enrich: {done_counter['n']}/{total}", flush=True)

            orig_tasks = [
                asyncio.create_task(check_original_one(nm))
                for nm in nm_ids
            ]
            await asyncio.gather(*orig_tasks, return_exceptions=True)

        # Финал
        seller_count = sum(1 for v in result.values() if v["seller"])
        orig_count = sum(1 for v in result.values() if v["is_original"])
        log.info(
            "fetch_seller_and_original_batch: готово за %.1fс | "
            "продавцы %d/%d | оригинал %d/%d",
            time.time() - t0, seller_count, total, orig_count, total,
        )
        return result

    # ------------------------------------------------------------------
    # Обёртки для удобства / совместимость с main_v39.py
    # ------------------------------------------------------------------

    async def enrich_cards_batch(
        self,
        cards: List[Any],
        workers: int = 10,
    ) -> None:
        """
        Обогащает список Card-объектов данными продавца и оригинала.

        Совместим с форматом main_v39.py — ожидает объекты с атрибутами:
            .nm_id (int), .seller_name (str), .supplier_id (str)

        Изменяет объекты на месте (in-place).
        """
        nm_ids = [safe_int(getattr(c, "nm_id", 0)) for c in cards]
        nm_ids = [nm for nm in nm_ids if nm > 0]
        if not nm_ids:
            return

        results = await self.fetch_seller_and_original_batch(nm_ids, workers=workers)
        nm_to_card = {safe_int(getattr(c, "nm_id", 0)): c for c in cards}
        for nm, data in results.items():
            card = nm_to_card.get(nm)
            if card is None:
                continue
            if not getattr(card, "seller_name", ""):
                card.seller_name = data.get("seller", "")
            if not getattr(card, "is_original", None):
                try:
                    card.is_original = data.get("is_original", False)
                except AttributeError:
                    pass


# ---------------------------------------------------------------------------
# Утилита: smoke-тест нескольких nm_id напрямую
# ---------------------------------------------------------------------------

async def _smoke_test(nm_ids: List[int], workers: int) -> None:
    """
    Выполняет smoke-тест: собирает данные для переданных nm_id и выводит JSON.

    Формат вывода:
    [{"nm_id": 68789915, "seller": "Diamod Shop", "is_original": false, "reason": "..."}]
    """
    if not _AIOHTTP_OK:
        print(
            json.dumps(
                [{"error": "aiohttp не установлен. pip install aiohttp"}],
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    client = WBEnhancedClient()
    log.info("Smoke-тест для %d артикулов: %s", len(nm_ids), nm_ids)

    results = await client.fetch_seller_and_original_batch(nm_ids, workers=workers)

    output = []
    for nm_id in nm_ids:
        data = results.get(nm_id, {})
        output.append(
            {
                "nm_id": nm_id,
                "seller": data.get("seller", ""),
                "is_original": data.get("is_original", False),
                "reason": data.get("reason", ""),
            }
        )

    print(json.dumps(output, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="wb_enhanced",
        description="Сборщик продавца и плашки «Оригинал» для WB-карточек",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Примеры:
  python wb_enhanced.py --nm 68789915
  python wb_enhanced.py --nm 68789915,123456789 --workers 5
  python wb_enhanced.py --nm 68789915 --log-level DEBUG
        """,
    )
    parser.add_argument(
        "--nm",
        required=True,
        help="Артикул(ы) WB через запятую. Пример: 68789915,123456789",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=5,
        help="Количество параллельных задач (по умолчанию: 5)",
    )
    parser.add_argument(
        "--dest",
        type=int,
        default=DEFAULT_DEST,
        help=f"Регион (dest) для WB API (по умолчанию: {DEFAULT_DEST} = Москва)",
    )
    parser.add_argument(
        "--domains",
        default=",".join(DEFAULT_HTML_DOMAINS),
        help=(
            "Домены WB для HTML-проверки через запятую "
            f"(по умолчанию: {','.join(DEFAULT_HTML_DOMAINS)})"
        ),
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Уровень логирования (по умолчанию: INFO)",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# v27.9.1: Браузерное определение плашки «Оригинал» (Playwright).
# Плашка «Оригинал»/«Оригинальный товар» рендерится на странице карточки WB
# через JS и НЕ присутствует ни в search-API, ни в basket card.json — поэтому
# HTTP-детектор всегда давал «не указано». Единственный надёжный способ —
# открыть карточку в браузере и увидеть бейдж так же, как видит пользователь.
# ---------------------------------------------------------------------------

_WB_ORIGINAL_DETECT_JS = r"""
() => {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // 1) Явный бейдж рядом с брендом: листовой элемент с точным текстом «Оригинал».
  const nodes = document.querySelectorAll('span, a, div, button, p');
  for (const n of nodes) {
    if (n.children && n.children.length === 0) {
      const t = norm(n.textContent);
      if (t === 'оригинал' || t === 'оригинальный товар') return true;
    }
  }
  // 2) Служебные атрибуты/классы оригинальности.
  if (document.querySelector('[class*="original" i], [data-link*="original" i], [aria-label*="ригинал" i]')) {
    return true;
  }
  return false;
}
"""


async def detect_original_badges_browser(
    nm_ids: List[int],
    headless: bool = True,
    workers: int = 3,
    timeout_ms: int = 20000,
    domain: str = "ru",
) -> Dict[int, bool]:
    """Открывает карточки WB в браузере и определяет наличие плашки «Оригинал».

    Возвращает {nm_id: True/False}. При недоступности Playwright — пустой dict
    (вызывающая сторона оставит «не указано»).
    """
    result: Dict[int, bool] = {}
    if not nm_ids:
        return result
    try:
        from playwright.async_api import async_playwright
    except Exception:
        log.warning("Playwright недоступен — браузерная проверка оригинальности пропущена")
        return result

    host = f"www.wildberries.{domain}" if "wildberries." not in domain else domain
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
    sem = asyncio.Semaphore(max(1, workers))

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless, args=[
            "--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage",
        ])
        context = await browser.new_context(user_agent=ua, locale="ru-RU",
                                            viewport={"width": 1366, "height": 900})

        async def check_one(nm: int) -> None:
            async with sem:
                page = await context.new_page()
                try:
                    url = f"https://{host}/catalog/{nm}/detail.aspx"
                    try:
                        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                    except Exception:
                        result[nm] = False
                        return
                    # Ждём отрисовки заголовка карточки (бренд+бейдж рядом).
                    try:
                        await page.wait_for_selector("h1", timeout=min(timeout_ms, 12000))
                    except Exception:
                        pass
                    is_orig = False
                    for _ in range(3):
                        try:
                            is_orig = bool(await page.evaluate(_WB_ORIGINAL_DETECT_JS))
                        except Exception:
                            is_orig = False
                        if is_orig:
                            break
                        await asyncio.sleep(0.7)
                    result[nm] = is_orig
                finally:
                    try:
                        await page.close()
                    except Exception:
                        pass

        await asyncio.gather(*[check_one(nm) for nm in nm_ids], return_exceptions=True)
        try:
            await context.close()
            await browser.close()
        except Exception:
            pass
    log.info("Браузерная проверка оригинальности: %d/%d с плашкой",
             sum(1 for v in result.values() if v), len(result))
    return result


def main() -> None:
    """Точка входа CLI."""
    args = _parse_args()

    # Устанавливаем уровень логирования
    log.setLevel(getattr(logging, args.log_level.upper(), logging.INFO))

    # Парсим nm_ids
    raw_nms = re.split(r"[,;\s]+", args.nm.strip())
    nm_ids: List[int] = []
    for raw in raw_nms:
        nm = safe_int(raw.strip())
        if nm > 0:
            nm_ids.append(nm)
        else:
            log.warning("Некорректный nm_id пропущен: %r", raw)

    if not nm_ids:
        print(
            json.dumps(
                [{"error": "Не переданы корректные nm_id"}],
                ensure_ascii=False,
                indent=2,
            )
        )
        sys.exit(1)

    # Применяем параметры к клиенту
    domains = [d.strip() for d in args.domains.split(",") if d.strip()]

    # Monkey-patch клиент с параметрами из CLI
    WBEnhancedClient.__init__.__defaults__  # noqa — просто используем конструктор
    client_kwargs = {
        "dest": args.dest,
        "html_domains": domains,
    }
    # Переопределяем дефолт для smoke-теста
    original_init = WBEnhancedClient.__init__

    def patched_init(self_obj: WBEnhancedClient, **kwargs: Any) -> None:
        original_init(self_obj, **{**client_kwargs, **kwargs})

    WBEnhancedClient.__init__ = patched_init  # type: ignore[method-assign]

    try:
        asyncio.run(_smoke_test(nm_ids, workers=args.workers))
    except KeyboardInterrupt:
        log.info("Прервано пользователем")
        sys.exit(0)
    except Exception as e:
        log.error("Критическая ошибка: %s", e, exc_info=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Для прямого запуска модуля
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    main()
