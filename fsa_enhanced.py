"""
fsa_enhanced.py — Расширенный парсер документов ФСА (pub.fsa.gov.ru)
=====================================================================
Версия: 1.0.0   (2026-06-05)

Возможности:
  - Bearer-токен с кэшированием (срок жизни 24 часа)
  - curl_cffi с impersonate='chrome' для обхода TLS-fingerprint
  - Цепочка fallback: chrome → chrome136 → chrome137
  - Warm-up последовательность (как в HAR-записи браузера)
  - Эвристический поиск полей (find_nested_value) — API-версионно-устойчивый
  - Поддержка сертификатов (RSS) и деклараций (RDS)
  - Маппинг статусов на русский язык
  - Форматирование дат в DD.MM.YYYY
  - Объединение списковых полей в строки через разделители
  - Все поля по разделам 3.4–3.5 research_apis.md

Использование:
    from fsa_enhanced import FSAEnhancedClient
    client = FSAEnhancedClient(timeout=12.0)
    result = client.parse_fsa_full("https://pub.fsa.gov.ru/rss/certificate/view/2406631/baseInfo")
    print(result)

CLI smoke-тест:
    python fsa_enhanced.py https://pub.fsa.gov.ru/rss/certificate/view/2406631/baseInfo
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Опциональный импорт curl_cffi
# ---------------------------------------------------------------------------
try:
    from curl_cffi import requests as _curl_requests  # type: ignore
    _CURL_CFFI_AVAILABLE = True
except ImportError:
    _curl_requests = None  # type: ignore
    _CURL_CFFI_AVAILABLE = False

logger = logging.getLogger("fsa_enhanced")

# ---------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------

FSA_BASE_URL = "https://pub.fsa.gov.ru"
FSA_API_BASE = f"{FSA_BASE_URL}/api/v1"
FSA_TOKEN_URL = f"{FSA_API_BASE}/auth/token"

# Маппинг статусов (ключи в нижнем регистре для case-insensitive сравнения)
STATUS_MAPPING: Dict[str, str] = {
    "valid":       "Действует",
    "active":      "Действует",
    "cancelled":   "Прекращён",
    "canceled":    "Прекращён",
    "terminated":  "Прекращён",
    "suspended":   "Приостановлен",
    "paused":      "Приостановлен",
    "renewed":     "Возобновлен",
    "expired":     "Истёк",
    "revoked":     "Отозван",
    "archived":    "В архиве",
}

# User-Agent Chrome-136 (стабильный для ФСА)
_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/136.0.0.0 Safari/537.36"
)

# Fallback-цепочка impersonate-профилей
_IMPERSONATE_CHAIN = ["chrome", "chrome136", "chrome137"]

# Таймаут на один API-запрос (сек) — мягкий, жёсткий — через параметр __init__
_TOKEN_RENEW_MARGIN_SEC = 120  # обновлять токен за 2 минуты до истечения


# ---------------------------------------------------------------------------
# Вспомогательные функции — парсинг URL
# ---------------------------------------------------------------------------

def extract_fsa_kind_and_id(url: str) -> Tuple[str, str]:
    """
    Из любого FSA-URL извлекает (kind, doc_id).

    kind:
      "rss_certificate" — для сертификатов (/rss/certificate/...)
      "rds_declaration" — для деклараций (/rds/declaration/...)

    Возвращает ('', '') если URL не относится к pub.fsa.gov.ru
    или не содержит числового ID.

    Поддерживаемые форматы:
      https://pub.fsa.gov.ru/rss/certificate/view/{id}/baseInfo
      https://pub.fsa.gov.ru/rds/declaration/view/{id}/common
      https://pub.fsa.gov.ru/api/v1/rss/common/certificates/{id}
      https://pub.fsa.gov.ru/api/v1/rds/common/declarations/{id}
      https://pub.fsa.gov.ru/api/v1/rss/common/certificate/{id}
      https://pub.fsa.gov.ru/api/v1/rds/common/declaration/{id}
    """
    try:
        parsed = urlparse(url)
        netloc = (parsed.netloc or "").lower()
        if "fsa.gov.ru" not in netloc:
            return "", ""
        path = parsed.path or ""

        # Шаблоны для сертификатов
        cert_patterns = [
            r"/rss/certificate(?:/view|/details|/card)?/(\d{3,})",
            r"/api/v\d+/rss/(?:common/)?certificates?/(\d{3,})",
        ]
        for pat in cert_patterns:
            m = re.search(pat, path)
            if m:
                return "rss_certificate", m.group(1)

        # Шаблоны для деклараций
        decl_patterns = [
            r"/rds/declaration(?:/view|/details|/card)?/(\d{3,})",
            r"/api/v\d+/rds/(?:common/)?declarations?/(\d{3,})",
        ]
        for pat in decl_patterns:
            m = re.search(pat, path)
            if m:
                return "rds_declaration", m.group(1)

    except Exception as exc:
        logger.debug("extract_fsa_kind_and_id error: %s", exc)

    return "", ""


# ---------------------------------------------------------------------------
# Вспомогательные функции — обработка данных
# ---------------------------------------------------------------------------

def _format_date(value: Any) -> str:
    """
    Преобразует ISO-дату (YYYY-MM-DD или YYYY-MM-DDThh:mm:ss...) в DD.MM.YYYY.
    Возвращает исходное строковое представление, если формат не распознан.
    """
    if value is None:
        return ""
    s = str(value).strip()
    if not s or s.lower() in ("null", "none", "undefined"):
        return ""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(3)}.{m.group(2)}.{m.group(1)}"
    # Уже может быть в DD.MM.YYYY
    m2 = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m2:
        return s
    # Число-метка времени (ms)
    if re.match(r"^\d{13}$", s):
        try:
            ts = int(s) / 1000
            import datetime
            dt = datetime.datetime.utcfromtimestamp(ts)
            return dt.strftime("%d.%m.%Y")
        except Exception:
            pass
    return s[:10] if len(s) >= 10 else s


def _map_status(raw: Any) -> str:
    """Возвращает 'Действует' / 'Прекращён' / ... по raw-значению статуса."""
    if not raw:
        return ""
    key = str(raw).strip().lower()
    return STATUS_MAPPING.get(key, str(raw).strip())


def _to_str(value: Any) -> str:
    """None / пустые значения → ''. Списки разворачиваем рекурсивно."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        s = value.strip()
        return s if s not in ("null", "undefined", "None") else ""
    if isinstance(value, (list, tuple)):
        parts = [_to_str(x) for x in value]
        return "; ".join(p for p in parts if p)
    if isinstance(value, dict):
        # Вернём fullAddress если есть, иначе пустую строку
        fa = value.get("fullAddress") or value.get("full_address") or ""
        return _to_str(fa)
    return str(value).strip()


# ---------------------------------------------------------------------------
# Эвристический поиск полей (find_nested_value)
# ---------------------------------------------------------------------------

def _iter_leaves(
    obj: Any,
    path: Tuple[str, ...] = (),
    max_depth: int = 12,
) -> Iterator[Tuple[Tuple[str, ...], Any]]:
    """
    Рекурсивный обход JSON (dict/list).
    Yield (path_tuple, leaf_value) для каждого листового значения.
    path_tuple содержит строковые имена ключей / "[N]" для индексов.
    """
    if max_depth <= 0:
        yield path, obj
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _iter_leaves(v, path + (str(k),), max_depth - 1)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from _iter_leaves(v, path + (f"[{i}]",), max_depth - 1)
    else:
        yield path, obj


def find_nested_value(
    obj: Any,
    keys: Tuple[str, ...],
    fallback_keys: Tuple[str, ...] = (),
    *,
    exclude_path_parts: Tuple[str, ...] = (),
    require_path_parts: Tuple[str, ...] = (),
    min_len: int = 1,
    max_len: int = 4096,
) -> str:
    """
    Ищет значение в глубоко вложенной структуре JSON.

    Алгоритм:
    1. Собирает все листья (path, value).
    2. Для каждого листа проверяет: путь содержит хотя бы один ключ из keys
       (или fallback_keys) в нижнем регистре, не содержит exclude_path_parts,
       содержит все require_path_parts.
    3. Возвращает первое не-пустое строковое значение.

    Параметры:
        obj                 — корень JSON-объекта (dict/list)
        keys                — основные ключевые слова для поиска в пути
        fallback_keys       — резервные ключевые слова (используются если
                              по основным ничего не найдено)
        exclude_path_parts  — части пути которых НЕ должно быть
        require_path_parts  — части пути которые ОБЯЗАТЕЛЬНО должны быть
        min_len             — минимальная длина значения (по умолчанию 1)
        max_len             — максимальная длина значения
    """
    def _search(search_keys: Tuple[str, ...]) -> str:
        if not search_keys:
            return ""
        lkeys = tuple(k.lower() for k in search_keys)
        exc = tuple(e.lower() for e in exclude_path_parts)
        req = tuple(r.lower() for r in require_path_parts)
        for path, leaf in _iter_leaves(obj):
            if leaf is None or isinstance(leaf, (dict, list)):
                continue
            s = _to_str(leaf)
            if not s or len(s) < min_len or len(s) > max_len:
                continue
            pl = "/".join(path).lower()
            # Проверяем исключения
            if any(e in pl for e in exc):
                continue
            # Проверяем обязательные части пути
            if req and not all(r in pl for r in req):
                continue
            # Проверяем наличие хотя бы одного из ключевых слов
            if any(k in pl for k in lkeys):
                return s
        return ""

    result = _search(keys)
    if not result and fallback_keys:
        result = _search(fallback_keys)
    return result


def find_nested_all(
    obj: Any,
    keys: Tuple[str, ...],
    *,
    exclude_path_parts: Tuple[str, ...] = (),
    require_path_parts: Tuple[str, ...] = (),
    max_len: int = 4096,
) -> List[str]:
    """
    Как find_nested_value, но возвращает ВСЕ уникальные не-пустые значения
    по указанным ключам в порядке обхода.
    Используется для объединения списковых полей (ТН ВЭД, ГОСТ, ТР ТС, ...).
    """
    if not keys:
        return []
    lkeys = tuple(k.lower() for k in keys)
    exc = tuple(e.lower() for e in exclude_path_parts)
    req = tuple(r.lower() for r in require_path_parts)
    seen: set = set()
    result: List[str] = []
    for path, leaf in _iter_leaves(obj):
        if leaf is None or isinstance(leaf, (dict, list)):
            continue
        s = _to_str(leaf)
        if not s or len(s) > max_len:
            continue
        pl = "/".join(path).lower()
        if any(e in pl for e in exc):
            continue
        if req and not all(r in pl for r in req):
            continue
        if any(k in pl for k in lkeys):
            if s not in seen:
                seen.add(s)
                result.append(s)
    return result


# ---------------------------------------------------------------------------
# HTTP headers & warm-up
# ---------------------------------------------------------------------------

def _build_browser_headers(
    referer: str,
    *,
    bearer_token: Optional[str] = None,
    accept_json: bool = True,
) -> Dict[str, str]:
    """
    Заголовки имитирующие Chrome из HAR-записи реальной сессии на pub.fsa.gov.ru.
    Без Origin/XHR-маркеров — их отправка провоцирует 403.
    """
    accept = "application/json, text/plain, */*" if accept_json else (
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,"
        "image/webp,*/*;q=0.8"
    )
    h: Dict[str, str] = {
        "Accept": accept,
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": referer,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": _DEFAULT_UA,
        # Нестандартные заголовки ФСА (видны в HAR)
        "lkId": "",
        "orgId": "",
        "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not/A)Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }
    if bearer_token:
        h["Authorization"] = f"Bearer {bearer_token}"
    return h


def _build_warmup_sequence(kind: str, doc_id: str, referer: str) -> List[Tuple[str, str]]:
    """
    Warm-up URL-ы из HAR-записи браузера.
    Без этой последовательности ФСА часто возвращает 403.

    Возвращает список (url, accept_type) где accept_type = 'html' | 'json'.
    """
    base = "rss" if kind == "rss_certificate" else "rds"
    return [
        (referer, "html"),
        ("https://pub.fsa.gov.ru/assets/i18n/ru.json", "json"),
        ("https://pub.fsa.gov.ru/lk/api/account", "json"),
        (f"https://pub.fsa.gov.ru/api/v1/{base}/common/account", "json"),
    ]


def _build_api_candidates(kind: str, doc_id: str) -> List[Tuple[str, str]]:
    """
    Список (label, url) API-эндпоинтов для перебора.
    Порядок: сначала подтверждённый HAR-endpoint (множественное число),
    затем устаревший (единственное число).
    """
    if kind == "rss_certificate":
        return [
            ("rss_certificates_new",
             f"{FSA_API_BASE}/rss/common/certificates/{doc_id}"),
            ("rss_certificate_old",
             f"{FSA_API_BASE}/rss/common/certificate/{doc_id}"),
        ]
    if kind == "rds_declaration":
        return [
            ("rds_declarations_new",
             f"{FSA_API_BASE}/rds/common/declarations/{doc_id}"),
            ("rds_declaration_old",
             f"{FSA_API_BASE}/rds/common/declaration/{doc_id}"),
        ]
    return []


# ---------------------------------------------------------------------------
# Разворачивание вложенного payload
# ---------------------------------------------------------------------------

def _unwrap_payload(obj: Any, max_depth: int = 5) -> Any:
    """
    FSA иногда оборачивает полезную нагрузку в {data: ...}, {item: ...},
    {certificate: ...}, {declaration: ...} и т.п.
    Рекурсивно разворачиваем до содержательного dict/list.
    """
    wrapper_keys = (
        "data", "item", "result", "content", "payload",
        "declaration", "certificate", "document",
        "response", "object",
    )
    current = obj
    for _ in range(max_depth):
        if isinstance(current, dict):
            for k in wrapper_keys:
                v = current.get(k)
                if isinstance(v, (dict, list)) and v:
                    current = v
                    break
            else:
                break
        elif isinstance(current, list) and len(current) == 1 and isinstance(current[0], dict):
            current = current[0]
        else:
            break
    return current


# ---------------------------------------------------------------------------
# Основной парсер полей FSA
# ---------------------------------------------------------------------------

class FSAFieldExtractor:
    """
    Извлекает все поля из JSON-ответа FSA.
    Содержит всю логику deep-extraction, маппинга, форматирования.
    Не зависит от HTTP-слоя — принимает уже десериализованный dict.
    """

    def __init__(self, raw: Any, *, kind: str, doc_id: str, source_url: str):
        self.raw = raw
        self.payload = _unwrap_payload(raw)
        self.kind = kind
        self.doc_id = doc_id
        self.source_url = source_url
        # Кэшируем листья (дорогостоящий обход делаем один раз)
        self._leaves: Optional[List[Tuple[Tuple[str, ...], Any]]] = None

    def _get_leaves(self) -> List[Tuple[Tuple[str, ...], Any]]:
        if self._leaves is None:
            self._leaves = list(_iter_leaves(self.payload))
        return self._leaves

    # ------------------------------------------------------------------
    # Примитивные геттеры
    # ------------------------------------------------------------------

    def _get(
        self,
        *,
        keys: Tuple[str, ...],
        fallback: Tuple[str, ...] = (),
        exc: Tuple[str, ...] = (),
        req: Tuple[str, ...] = (),
    ) -> str:
        return find_nested_value(
            self.payload, keys, fallback,
            exclude_path_parts=exc,
            require_path_parts=req,
        )

    def _get_all(
        self,
        *,
        keys: Tuple[str, ...],
        exc: Tuple[str, ...] = (),
        req: Tuple[str, ...] = (),
    ) -> List[str]:
        return find_nested_all(
            self.payload, keys,
            exclude_path_parts=exc,
            require_path_parts=req,
        )

    def _get_date(self, *, keys: Tuple[str, ...], exc: Tuple[str, ...] = ()) -> str:
        return _format_date(self._get(keys=keys, exc=exc))

    # ------------------------------------------------------------------
    # Прямые path-based геттеры (быстрее для известных структур)
    # ------------------------------------------------------------------

    def _path(self, obj: Any, *keys: str, default: Any = None) -> Any:
        """Безопасный обход по цепочке ключей."""
        cur = obj
        for k in keys:
            if isinstance(cur, dict):
                cur = cur.get(k)
                if cur is None:
                    return default
            elif isinstance(cur, list):
                try:
                    idx = int(k.strip("[]"))
                    cur = cur[idx]
                except (ValueError, IndexError):
                    return default
            else:
                return default
        return cur if cur is not None else default

    # ------------------------------------------------------------------
    # Секция: базовые поля
    # ------------------------------------------------------------------

    def _doc_type(self) -> str:
        return "Сертификат" if self.kind == "rss_certificate" else "Декларация"

    def _doc_number(self) -> str:
        # Прямой доступ сначала
        direct_keys = ("registrationNumber", "number", "regNumber",
                        "reg_number", "registrationNum")
        for k in direct_keys:
            v = self.payload.get(k) if isinstance(self.payload, dict) else None
            if v and isinstance(v, str):
                return v.strip()
        # Fallback — эвристика
        return self._get(
            keys=("registrationnumber", "regnumber", "number"),
            exc=("blank", "attestat", "protocol", "gost", "tu", "tn",
                 "applicant", "manufacturer", "lab", "body"),
        )

    def _blank_number(self) -> str:
        direct = (self.payload.get("blankNumber") or self.payload.get("blank_number")
                  if isinstance(self.payload, dict) else None)
        if direct:
            return _to_str(direct)
        return self._get(keys=("blanknumber", "blank_number", "blanknum"))

    def _status_raw(self) -> str:
        if isinstance(self.payload, dict):
            s = self.payload.get("status") or self.payload.get("idStatus")
            if s and not isinstance(s, (dict, list)):
                return str(s).strip()
        return self._get(
            keys=("status",),
            exc=("history", "change", "prev", "old"),
        )

    def _status_ru(self, raw: str) -> str:
        return _map_status(raw) or raw

    def _status_date(self) -> str:
        return self._get_date(
            keys=("statusdate", "status_date", "changedate", "statuschangedate"),
        )

    def _status_reason(self) -> str:
        return self._get(
            keys=("statusreason", "status_reason", "statusbasis", "basis",
                  "decisionnumber", "decisioninfo", "cancellationreason"),
            exc=("date",),
        )

    def _date_start(self) -> str:
        return self._get_date(
            keys=("certregdate", "regdate", "registrationdate", "datestart",
                  "date_start", "issuedate", "startdate", "issueddate"),
            exc=("end", "expir", "till"),
        )

    def _date_end(self) -> str:
        direct = None
        if isinstance(self.payload, dict):
            direct = self.payload.get("certEndDate") or self.payload.get("certenddate")
        if direct:
            return _format_date(direct)
        return self._get_date(
            keys=("certenddate", "enddate", "datetill", "date_end",
                  "expirationdate", "validtill", "expirydate"),
        )

    def _cert_end_unlimited(self) -> str:
        if isinstance(self.payload, dict):
            v = self.payload.get("certEndDateUnlimited")
            if v is not None:
                return "Да" if v else "Нет"
        found = self._get(keys=("enddateunlimited", "certendunlimited", "unlimited"))
        if found:
            return "Да" if str(found).lower() in ("true", "1", "yes", "да") else "Нет"
        return ""

    def _scheme(self) -> str:
        if isinstance(self.payload, dict):
            v = (self.payload.get("certificationScheme")
                 or self.payload.get("declarationScheme")
                 or self.payload.get("scheme"))
            if v and isinstance(v, str):
                return v.strip()
        return self._get(
            keys=("certificationscheme", "declarationscheme", "scheme"),
            exc=("description", "desc"),
        )

    # ------------------------------------------------------------------
    # Секция: заявитель
    # ------------------------------------------------------------------

    def _applicant_obj(self) -> Any:
        if isinstance(self.payload, dict):
            return self.payload.get("applicant") or {}
        return {}

    def _applicant_full_name(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("fullName") or a.get("full_name") or a.get("name")) or ""
        return find_nested_value(
            self.payload, ("fullname",),
            require_path_parts=("applicant",),
        )

    def _applicant_short_name(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("shortName") or a.get("short_name")) or ""
        return find_nested_value(
            self.payload, ("shortname",),
            require_path_parts=("applicant",),
        )

    def _applicant_inn(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("inn") or a.get("INN")) or ""
        return find_nested_value(
            self.payload, ("inn",),
            require_path_parts=("applicant",),
        )

    def _applicant_ogrn(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("ogrn") or a.get("OGRN")) or ""
        return find_nested_value(
            self.payload, ("ogrn",),
            require_path_parts=("applicant",),
        )

    def _applicant_kpp(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("kpp") or a.get("KPP")) or ""
        return find_nested_value(
            self.payload, ("kpp",),
            require_path_parts=("applicant",),
        )

    def _applicant_address(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            addr = a.get("address") or {}
            if isinstance(addr, dict):
                fa = addr.get("fullAddress") or addr.get("full_address")
                if fa:
                    return _to_str(fa)
            # Если address — строка
            if isinstance(addr, str):
                return addr.strip()
        return find_nested_value(
            self.payload, ("fulladdress", "full_address"),
            require_path_parts=("applicant",),
            exclude_path_parts=("actual",),
        )

    def _applicant_actual_address(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            aa = a.get("actualAddress") or a.get("actual_address") or {}
            if isinstance(aa, dict):
                fa = aa.get("fullAddress") or aa.get("full_address")
                if fa:
                    return _to_str(fa)
        return find_nested_value(
            self.payload, ("fulladdress", "actualaddress"),
            require_path_parts=("applicant", "actual"),
        )

    def _applicant_phone(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("phone") or a.get("tel") or a.get("telephone")) or ""
        return find_nested_value(
            self.payload, ("phone", "tel"),
            require_path_parts=("applicant",),
        )

    def _applicant_email(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(a.get("email") or a.get("mail")) or ""
        return find_nested_value(
            self.payload, ("email", "mail"),
            require_path_parts=("applicant",),
        )

    def _applicant_head_fio(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(
                a.get("headFIO") or a.get("headfio") or a.get("head_fio")
                or a.get("directorFIO") or a.get("ceoName")
            ) or ""
        return find_nested_value(
            self.payload, ("headfio", "head_fio", "directorfio", "ceoname"),
            require_path_parts=("applicant",),
        )

    def _applicant_head_position(self) -> str:
        a = self._applicant_obj()
        if isinstance(a, dict):
            return _to_str(
                a.get("headPosition") or a.get("headposition") or a.get("head_position")
                or a.get("directorPosition") or a.get("ceoPosition")
            ) or ""
        return find_nested_value(
            self.payload, ("headposition", "directorposition"),
            require_path_parts=("applicant",),
        )

    # ------------------------------------------------------------------
    # Секция: изготовитель
    # ------------------------------------------------------------------

    def _manufacturer_obj(self) -> Any:
        if isinstance(self.payload, dict):
            return self.payload.get("manufacturer") or {}
        return {}

    def _manufacturer_full_name(self) -> str:
        m = self._manufacturer_obj()
        if isinstance(m, dict):
            return _to_str(m.get("fullName") or m.get("full_name") or m.get("name")) or ""
        return find_nested_value(
            self.payload, ("fullname",),
            require_path_parts=("manufacturer",),
        )

    def _manufacturer_inn(self) -> str:
        m = self._manufacturer_obj()
        if isinstance(m, dict):
            return _to_str(m.get("inn") or m.get("INN")) or ""
        return find_nested_value(
            self.payload, ("inn",),
            require_path_parts=("manufacturer",),
        )

    def _manufacturer_ogrn(self) -> str:
        m = self._manufacturer_obj()
        if isinstance(m, dict):
            return _to_str(m.get("ogrn") or m.get("OGRN")) or ""
        return find_nested_value(
            self.payload, ("ogrn",),
            require_path_parts=("manufacturer",),
        )

    def _manufacturer_country(self) -> str:
        m = self._manufacturer_obj()
        if isinstance(m, dict):
            country = m.get("country") or {}
            if isinstance(country, dict):
                return _to_str(
                    country.get("shortName") or country.get("short_name")
                    or country.get("name") or country.get("fullName")
                ) or ""
            if isinstance(country, str):
                return country.strip()
        return find_nested_value(
            self.payload, ("country", "countryname", "country_name"),
            require_path_parts=("manufacturer",),
        )

    def _manufacturer_address(self) -> str:
        m = self._manufacturer_obj()
        if isinstance(m, dict):
            addr = m.get("address") or {}
            if isinstance(addr, dict):
                fa = addr.get("fullAddress") or addr.get("full_address")
                if fa:
                    return _to_str(fa)
            if isinstance(addr, str):
                return addr.strip()
        return find_nested_value(
            self.payload, ("fulladdress",),
            require_path_parts=("manufacturer",),
            exclude_path_parts=("branch", "actual"),
        )

    def _manufacturer_branches(self) -> str:
        m = self._manufacturer_obj()
        branches: List[str] = []
        if isinstance(m, dict):
            br_list = m.get("branches") or m.get("branchAddresses") or []
            if isinstance(br_list, list):
                for br in br_list:
                    if isinstance(br, dict):
                        addr = br.get("address") or {}
                        if isinstance(addr, dict):
                            fa = addr.get("fullAddress") or addr.get("full_address") or ""
                        elif isinstance(addr, str):
                            fa = addr
                        else:
                            fa = _to_str(br)
                        if fa:
                            branches.append(fa.strip())
                    elif isinstance(br, str):
                        branches.append(br.strip())
        return "; ".join(branches)

    # ------------------------------------------------------------------
    # Секция: продукция
    # ------------------------------------------------------------------

    def _product_obj(self) -> Any:
        if isinstance(self.payload, dict):
            return self.payload.get("product") or self.payload.get("products") or {}
        return {}

    def _product_full_name(self) -> str:
        p = self._product_obj()
        if isinstance(p, dict):
            return _to_str(p.get("fullName") or p.get("full_name") or p.get("name")) or ""
        return find_nested_value(
            self.payload, ("fullname",),
            require_path_parts=("product",),
        )

    def _product_uniform_name(self) -> str:
        p = self._product_obj()
        if isinstance(p, dict):
            return _to_str(
                p.get("uniformName") or p.get("uniform_name")
                or p.get("uniformProductName")
            ) or ""
        return find_nested_value(
            self.payload, ("uniformname", "uniform_name"),
            require_path_parts=("product",),
        )

    def _product_tnved(self) -> str:
        """Первичный код ТН ВЭД."""
        p = self._product_obj()
        if isinstance(p, dict):
            v = p.get("tnVedCode") or p.get("tnved_code") or p.get("tnVed") or p.get("tnved")
            if v:
                return _to_str(v)
        return find_nested_value(
            self.payload, ("tnvedcode", "tn_ved", "tnved"),
            require_path_parts=("product",),
            exclude_path_parts=("codes",),
        )

    def _product_tnved_all(self) -> str:
        """Все коды ТН ВЭД объединённые через ', '."""
        p = self._product_obj()
        codes: List[str] = []
        if isinstance(p, dict):
            raw_codes = p.get("tnVedCodes") or p.get("tnved_codes") or p.get("tnVedCodeList") or []
            if isinstance(raw_codes, list):
                for c in raw_codes:
                    if isinstance(c, dict):
                        v = c.get("code") or c.get("tnVedCode") or c.get("value") or str(c)
                    else:
                        v = str(c)
                    if v and v.strip():
                        codes.append(v.strip())
        if not codes:
            # Fallback — эвристика по всему payload
            codes = find_nested_all(
                self.payload, ("tnvedcodes", "tnved_codes", "tnvedcode", "tnved"),
                require_path_parts=("product",),
            )
        # Дедупликация
        seen: set = set()
        deduped = []
        for c in codes:
            if c not in seen:
                seen.add(c)
                deduped.append(c)
        return ", ".join(deduped)

    def _product_model(self) -> str:
        p = self._product_obj()
        if isinstance(p, dict):
            return _to_str(
                p.get("model") or p.get("modelName") or p.get("model_name")
                or p.get("partNumber") or p.get("part_number")
            ) or ""
        return find_nested_value(
            self.payload, ("model", "modeln"),
            require_path_parts=("product",),
        )

    def _product_article(self) -> str:
        p = self._product_obj()
        if isinstance(p, dict):
            return _to_str(p.get("article") or p.get("articleNumber")) or ""
        return find_nested_value(
            self.payload, ("article",),
            require_path_parts=("product",),
        )

    def _product_gost_tu(self) -> str:
        """ГОСТ/ТУ объединённые через '; '."""
        p = self._product_obj()
        items: List[str] = []
        if isinstance(p, dict):
            gost_list = p.get("gostTu") or p.get("gost_tu") or p.get("standardList") or []
            if isinstance(gost_list, list):
                for g in gost_list:
                    if isinstance(g, dict):
                        num = g.get("number") or g.get("designation") or g.get("name") or ""
                        if num:
                            items.append(str(num).strip())
                    elif isinstance(g, str):
                        items.append(g.strip())
        if not items:
            items = find_nested_all(
                self.payload, ("gosttu", "gost_tu", "number"),
                require_path_parts=("gost",),
            )
        return "; ".join(items)

    def _product_production_type(self) -> str:
        p = self._product_obj()
        if isinstance(p, dict):
            return _to_str(
                p.get("productionType") or p.get("production_type")
                or p.get("batchInfo") or p.get("serialProduction")
            ) or ""
        return find_nested_value(
            self.payload, ("productiontype", "production_type", "batchinfo"),
            require_path_parts=("product",),
        )

    def _product_additional_info(self) -> str:
        p = self._product_obj()
        if isinstance(p, dict):
            return _to_str(
                p.get("additionalInfo") or p.get("additional_info")
                or p.get("addInfo") or p.get("remarks")
            ) or ""
        return find_nested_value(
            self.payload, ("additionalinfo", "additional_info"),
            require_path_parts=("product",),
        )

    # ------------------------------------------------------------------
    # Секция: технические регламенты
    # ------------------------------------------------------------------

    def _tech_regulations_list(self) -> List[Dict[str, str]]:
        """Возвращает список dict с ключами shortName / fullName."""
        if isinstance(self.payload, dict):
            raw = (
                self.payload.get("techRegulationDetails")
                or self.payload.get("tech_regulation_details")
                or self.payload.get("techRegulations")
                or self.payload.get("technicalRegulations")
                or []
            )
            if isinstance(raw, list):
                result = []
                for item in raw:
                    if isinstance(item, dict):
                        result.append({
                            "short": _to_str(item.get("shortName") or item.get("short_name") or ""),
                            "full": _to_str(item.get("fullName") or item.get("full_name") or ""),
                        })
                    elif isinstance(item, str):
                        result.append({"short": item, "full": ""})
                return result
        return []

    def _tech_regulations_short(self) -> str:
        items = self._tech_regulations_list()
        parts = [i["short"] for i in items if i["short"]]
        if not parts:
            parts = find_nested_all(
                self.payload,
                ("shortname", "short_name"),
                require_path_parts=("techreg", "regulation"),
            )
        return "; ".join(parts)

    def _tech_regulations_full(self) -> str:
        items = self._tech_regulations_list()
        parts = [i["full"] for i in items if i["full"]]
        if not parts:
            parts = find_nested_all(
                self.payload,
                ("fullname", "full_name"),
                require_path_parts=("techreg", "regulation"),
            )
        return "; ".join(parts)

    # ------------------------------------------------------------------
    # Секция: орган по сертификации / регистрирующий орган
    # ------------------------------------------------------------------

    def _cert_body_obj(self) -> Any:
        if isinstance(self.payload, dict):
            return (
                self.payload.get("certificationBody")
                or self.payload.get("certification_body")
                or self.payload.get("registrationBody")
                or self.payload.get("registration_body")
                or {}
            )
        return {}

    def _cert_body_name(self) -> str:
        b = self._cert_body_obj()
        if isinstance(b, dict):
            return _to_str(b.get("fullName") or b.get("full_name") or b.get("name")) or ""
        return find_nested_value(
            self.payload, ("fullname",),
            require_path_parts=("body",),
            exclude_path_parts=("applicant", "manufacturer", "lab"),
        )

    def _cert_body_attestat(self) -> str:
        b = self._cert_body_obj()
        if isinstance(b, dict):
            return _to_str(
                b.get("attestatNumber") or b.get("attestat_number")
                or b.get("accreditationNumber")
            ) or ""
        return find_nested_value(
            self.payload, ("attestatnumber", "attestat_number"),
            require_path_parts=("body",),
        )

    def _cert_body_attestat_end(self) -> str:
        b = self._cert_body_obj()
        if isinstance(b, dict):
            raw = (
                b.get("attestatEndDate") or b.get("attestat_end_date")
                or b.get("accreditationEndDate")
            )
            if raw:
                return _format_date(raw)
        return ""

    def _cert_body_address(self) -> str:
        b = self._cert_body_obj()
        if isinstance(b, dict):
            addr = b.get("address") or {}
            if isinstance(addr, dict):
                fa = addr.get("fullAddress") or addr.get("full_address") or ""
                return _to_str(fa)
            if isinstance(addr, str):
                return addr.strip()
        return find_nested_value(
            self.payload, ("fulladdress",),
            require_path_parts=("body",),
        )

    def _cert_body_phone(self) -> str:
        b = self._cert_body_obj()
        if isinstance(b, dict):
            return _to_str(b.get("phone") or b.get("tel")) or ""
        return find_nested_value(
            self.payload, ("phone", "tel"),
            require_path_parts=("body",),
        )

    def _cert_body_email(self) -> str:
        b = self._cert_body_obj()
        if isinstance(b, dict):
            return _to_str(b.get("email") or b.get("mail")) or ""
        return find_nested_value(
            self.payload, ("email", "mail"),
            require_path_parts=("body",),
        )

    # ------------------------------------------------------------------
    # Секция: лаборатории и протоколы
    # ------------------------------------------------------------------

    def _testing_labs(self) -> str:
        if isinstance(self.payload, dict):
            labs = (
                self.payload.get("testingLabs")
                or self.payload.get("testing_labs")
                or self.payload.get("testLabs")
                or []
            )
            if isinstance(labs, list):
                parts = []
                for lab in labs:
                    if isinstance(lab, dict):
                        name = _to_str(lab.get("fullName") or lab.get("name") or "")
                        att = _to_str(lab.get("attestatNumber") or lab.get("attestat_number") or "")
                        end = _format_date(lab.get("attestatEndDate") or lab.get("attestat_end_date") or "")
                        entry = name
                        if att:
                            entry += f" (аттестат {att}"
                            if end:
                                entry += f", до {end}"
                            entry += ")"
                        if entry.strip():
                            parts.append(entry)
                    elif isinstance(lab, str):
                        parts.append(lab.strip())
                if parts:
                    return "; ".join(parts)
        return find_nested_value(
            self.payload, ("fullname", "labname"),
            require_path_parts=("lab",),
        )

    def _test_protocols(self) -> str:
        if isinstance(self.payload, dict):
            protocols = (
                self.payload.get("testProtocols")
                or self.payload.get("test_protocols")
                or self.payload.get("protocols")
                or []
            )
            if isinstance(protocols, list):
                parts = []
                for p in protocols:
                    if isinstance(p, dict):
                        num = _to_str(p.get("number") or p.get("num") or p.get("protocolNumber") or "")
                        date = _format_date(p.get("date") or p.get("issueDate") or p.get("protocolDate") or "")
                        lab = _to_str(p.get("labName") or p.get("lab_name") or p.get("laboratoryName") or "")
                        entry = f"№{num}" if num else ""
                        if date:
                            entry += f" от {date}"
                        if lab:
                            entry += f" ({lab})"
                        if entry.strip():
                            parts.append(entry.strip())
                    elif isinstance(p, str):
                        parts.append(p.strip())
                if parts:
                    return "; ".join(parts)
        return ""

    # ------------------------------------------------------------------
    # Секция: документы/приложения
    # ------------------------------------------------------------------

    def _documents_raw(self) -> List[Any]:
        if isinstance(self.payload, dict):
            docs = self.payload.get("documents") or self.payload.get("attachments") or []
            if isinstance(docs, list):
                return docs
        return []

    def _documents_count(self) -> str:
        return str(len(self._documents_raw()))

    def _documents_urls(self) -> str:
        docs = self._documents_raw()
        urls = []
        for doc in docs:
            if isinstance(doc, dict):
                url = doc.get("url") or doc.get("fileUrl") or doc.get("file_url") or ""
                if url:
                    urls.append(_to_str(url))
        return "\n".join(urls)

    # ------------------------------------------------------------------
    # Секция: ЕАЭС группа
    # ------------------------------------------------------------------

    def _eacs_product_group(self) -> str:
        if isinstance(self.payload, dict):
            grp = (
                self.payload.get("eacsProductGroup")
                or self.payload.get("eacs_product_group")
                or self.payload.get("productGroup")
                or {}
            )
            if isinstance(grp, dict):
                return _to_str(
                    grp.get("name") or grp.get("groupName") or grp.get("title")
                ) or ""
            if isinstance(grp, str):
                return grp.strip()
        return find_nested_value(
            self.payload, ("productgroup", "product_group", "eacsproductgroup"),
        )

    # ------------------------------------------------------------------
    # Секция: история
    # ------------------------------------------------------------------

    def _history_raw(self) -> List[Any]:
        if isinstance(self.payload, dict):
            h = self.payload.get("history") or self.payload.get("statusHistory") or []
            if isinstance(h, list):
                return h
        return []

    def _history_count(self) -> str:
        return str(len(self._history_raw()))

    def _last_history_date(self) -> str:
        h = self._history_raw()
        if not h:
            return ""
        last = h[-1]
        if isinstance(last, dict):
            raw = last.get("date") or last.get("changeDate") or last.get("statusDate") or ""
            return _format_date(raw)
        return ""

    def _last_history_status(self) -> str:
        h = self._history_raw()
        if not h:
            return ""
        last = h[-1]
        if isinstance(last, dict):
            raw = last.get("status") or last.get("statusCode") or ""
            return _map_status(raw) or _to_str(raw)
        return ""

    # ------------------------------------------------------------------
    # Служебные / технические поля
    # ------------------------------------------------------------------

    def _create_date(self) -> str:
        if isinstance(self.payload, dict):
            raw = self.payload.get("createDate") or self.payload.get("create_date") or self.payload.get("createdAt") or ""
            if raw:
                return _format_date(raw)
        return ""

    def _update_date(self) -> str:
        if isinstance(self.payload, dict):
            raw = self.payload.get("updateDate") or self.payload.get("update_date") or self.payload.get("updatedAt") or ""
            if raw:
                return _format_date(raw)
        return ""

    # ------------------------------------------------------------------
    # Главный метод: сборка плоского словаря
    # ------------------------------------------------------------------

    def extract(self) -> Dict[str, str]:
        """
        Возвращает плоский dict со всеми полями.
        Пустые значения НЕ включаются в результат.
        """
        status_raw = self._status_raw()
        status_ru = self._status_ru(status_raw)

        result: Dict[str, str] = {}

        def _set(key: str, value: str) -> None:
            v = str(value).strip() if value else ""
            if v:
                result[key] = v

        # --- Базовые ---
        _set("doc_type", self._doc_type())
        _set("doc_id", self.doc_id)
        _set("doc_number", self._doc_number())
        _set("blank_number", self._blank_number())
        _set("status", status_raw)
        _set("status_ru", status_ru)
        _set("status_date", self._status_date())
        _set("status_reason", self._status_reason())
        _set("date_start", self._date_start())
        _set("date_end", self._date_end())
        _set("cert_end_unlimited", self._cert_end_unlimited())
        _set("certification_scheme", self._scheme())

        # --- Заявитель ---
        _set("applicant_full_name", self._applicant_full_name())
        _set("applicant_short_name", self._applicant_short_name())
        _set("applicant_inn", self._applicant_inn())
        _set("applicant_ogrn", self._applicant_ogrn())
        _set("applicant_kpp", self._applicant_kpp())
        _set("applicant_address", self._applicant_address())
        _set("applicant_actual_address", self._applicant_actual_address())
        _set("applicant_phone", self._applicant_phone())
        _set("applicant_email", self._applicant_email())
        _set("applicant_head_fio", self._applicant_head_fio())
        _set("applicant_head_position", self._applicant_head_position())

        # --- Изготовитель ---
        _set("manufacturer_full_name", self._manufacturer_full_name())
        _set("manufacturer_inn", self._manufacturer_inn())
        _set("manufacturer_ogrn", self._manufacturer_ogrn())
        _set("manufacturer_country", self._manufacturer_country())
        _set("manufacturer_address", self._manufacturer_address())
        _set("manufacturer_branches", self._manufacturer_branches())

        # --- Продукция ---
        _set("product_full_name", self._product_full_name())
        _set("product_uniform_name", self._product_uniform_name())
        _set("product_tnved", self._product_tnved())
        _set("product_tnved_all", self._product_tnved_all())
        _set("product_model", self._product_model())
        _set("product_article", self._product_article())
        _set("product_gost_tu", self._product_gost_tu())
        _set("product_production_type", self._product_production_type())
        _set("product_additional_info", self._product_additional_info())

        # --- Технический регламент ---
        _set("tech_regulations", self._tech_regulations_short())
        _set("tech_regulations_full", self._tech_regulations_full())

        # --- Орган по сертификации ---
        _set("cert_body_name", self._cert_body_name())
        _set("cert_body_attestat", self._cert_body_attestat())
        _set("cert_body_attestat_end", self._cert_body_attestat_end())
        _set("cert_body_address", self._cert_body_address())
        _set("cert_body_phone", self._cert_body_phone())
        _set("cert_body_email", self._cert_body_email())

        # --- Лаборатории и протоколы ---
        _set("testing_labs", self._testing_labs())
        _set("test_protocols", self._test_protocols())

        # --- Документы ---
        _set("documents_count", self._documents_count())
        _set("documents_urls", self._documents_urls())

        # --- ЕАЭС ---
        _set("eacs_product_group", self._eacs_product_group())

        # --- История ---
        _set("history_count", self._history_count())
        _set("last_history_date", self._last_history_date())
        _set("last_history_status", self._last_history_status())

        # --- Технические ---
        _set("create_date", self._create_date())
        _set("update_date", self._update_date())
        _set("source", f"fsa_enhanced:{self.source_url}")

        return result


# ---------------------------------------------------------------------------
# Основной клиент
# ---------------------------------------------------------------------------

class FSAEnhancedClient:
    """
    Расширенный клиент для получения данных из API pub.fsa.gov.ru.

    Использует curl_cffi с impersonate='chrome' для обхода TLS-fingerprint.
    Получает Bearer-токен через /api/v1/auth/token (срок 24 часа, кэшируется).
    Поддерживает warm-up последовательность как у реального браузера.
    Fallback-цепочка: chrome → chrome136 → chrome137.

    Пример использования:
        client = FSAEnhancedClient(timeout=12.0)
        # Получить сертификат по ID
        raw = client.get_certificate("2406631")
        # Получить декларацию по ID
        raw = client.get_declaration("12345")
        # Разобрать по URL (главный метод)
        fields = client.parse_fsa_full("https://pub.fsa.gov.ru/rss/certificate/view/2406631/baseInfo")
    """

    def __init__(
        self,
        timeout: float = 12.0,
        *,
        user_agent: Optional[str] = None,
        skip_warmup: bool = False,
        cache_ttl: int = 3600,
    ):
        """
        Параметры:
            timeout     — таймаут одного HTTP-запроса (сек)
            user_agent  — кастомный User-Agent (по умолчанию Chrome-136)
            skip_warmup — пропустить warm-up (быстрее, но выше риск 403)
            cache_ttl   — время хранения в кэше (сек, по умолчанию 1 час)
        """
        if not _CURL_CFFI_AVAILABLE:
            logger.warning(
                "curl_cffi не установлен. FSAEnhancedClient работать не будет. "
                "Установите: pip install curl_cffi"
            )
        self.timeout = max(4.0, float(timeout))
        self.user_agent = user_agent or _DEFAULT_UA
        self.skip_warmup = skip_warmup
        self.cache_ttl = cache_ttl

        # Токен
        self._token: Optional[str] = None
        self._token_expires: float = 0.0

        # Кэш готовых результатов: cache_key → (timestamp, dict)
        self._cache: Dict[str, Tuple[float, Dict[str, str]]] = {}

        # Текущая сессия curl_cffi
        self._session: Optional[Any] = None
        self._session_impersonate: Optional[str] = None

    # ------------------------------------------------------------------
    # Управление сессией
    # ------------------------------------------------------------------

    def _get_session(self, impersonate: str) -> Any:
        """Возвращает сессию. Пересоздаёт если impersonate изменился."""
        if not _CURL_CFFI_AVAILABLE:
            raise RuntimeError("curl_cffi не установлен")
        if self._session is None or self._session_impersonate != impersonate:
            self._session = _curl_requests.Session()
            self._session_impersonate = impersonate
            # Сбрасываем токен при смене профиля — получим новый
            self._token = None
            self._token_expires = 0.0
        return self._session

    # ------------------------------------------------------------------
    # Управление токеном
    # ------------------------------------------------------------------

    def _refresh_token(self, sess: Any, impersonate: str) -> None:
        """
        Получает новый токен через /api/v1/auth/token.
        Использует кэшированный если он не истёк.
        """
        now = time.time()
        if self._token and now < self._token_expires - _TOKEN_RENEW_MARGIN_SEC:
            return  # токен ещё действителен

        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://pub.fsa.gov.ru/rss/certificate",
            "User-Agent": self.user_agent,
            "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not/A)Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }

        try:
            resp = self._do_get(sess, FSA_TOKEN_URL, headers=headers, impersonate=impersonate)
        except Exception as exc:
            raise RuntimeError(f"Не удалось получить токен ФСА: {exc}") from exc

        status = int(getattr(resp, "status_code", 0) or 0)
        if status != 200:
            raise RuntimeError(
                f"Токен ФСА: HTTP {status} на {FSA_TOKEN_URL}"
            )

        try:
            data = resp.json()
        except Exception as exc:
            raise RuntimeError(f"Токен ФСА: ошибка парсинга JSON: {exc}") from exc

        token = data.get("token") or data.get("access_token") or data.get("accessToken")
        if not token:
            raise RuntimeError(f"Токен ФСА: поле 'token' не найдено в ответе: {data}")

        expires_ms = data.get("expires_in") or data.get("expiresIn") or 86_400_000
        self._token = str(token)
        self._token_expires = now + float(expires_ms) / 1000.0
        logger.debug(
            "Токен ФСА получен, истекает через %.0f сек",
            self._token_expires - now,
        )

    # ------------------------------------------------------------------
    # Вспомогательный HTTP-запрос
    # ------------------------------------------------------------------

    def _do_get(
        self,
        sess: Any,
        url: str,
        *,
        headers: Dict[str, str],
        impersonate: str,
    ) -> Any:
        """Выполняет GET-запрос. Пробует передать impersonate, при TypeError — без него."""
        try:
            return sess.get(url, headers=headers, timeout=self.timeout, impersonate=impersonate)
        except TypeError:
            # Старая версия curl_cffi без поддержки impersonate в Session.get()
            return sess.get(url, headers=headers, timeout=self.timeout)

    # ------------------------------------------------------------------
    # Warm-up
    # ------------------------------------------------------------------

    def _do_warmup(
        self,
        sess: Any,
        impersonate: str,
        kind: str,
        doc_id: str,
        referer: str,
    ) -> None:
        """
        Выполняет warm-up запросы имитируя реальный браузер.
        Ошибки игнорируются — warm-up некритичен для результата,
        но значительно снижает вероятность 403.
        """
        for warmup_url, accept_type in _build_warmup_sequence(kind, doc_id, referer):
            try:
                h = _build_browser_headers(
                    referer,
                    accept_json=(accept_type == "json"),
                    bearer_token=self._token,
                )
                h["User-Agent"] = self.user_agent
                self._do_get(sess, warmup_url, headers=h, impersonate=impersonate)
                # Небольшая задержка между warm-up запросами
                time.sleep(0.15)
            except Exception as exc:
                logger.debug("Warm-up %s: %s", warmup_url, exc)

    # ------------------------------------------------------------------
    # Получение данных по ID
    # ------------------------------------------------------------------

    def _fetch_raw(
        self,
        kind: str,
        doc_id: str,
    ) -> Optional[Any]:
        """
        Выполняет всю цепочку:
        1. Для каждого impersonate-профиля:
           a. Получаем/обновляем токен
           b. Warm-up (если не отключён)
           c. Перебираем API-кандидаты
        2. Возвращает десериализованный JSON или None при полном провале.
        """
        if not _CURL_CFFI_AVAILABLE:
            logger.error("curl_cffi не установлен, запрос невозможен")
            return None

        referer = (
            f"{FSA_BASE_URL}/rds/declaration/view/{doc_id}/common"
            if kind == "rds_declaration"
            else f"{FSA_BASE_URL}/rss/certificate/view/{doc_id}/baseInfo"
        )

        for impersonate in _IMPERSONATE_CHAIN:
            logger.debug("Попытка с impersonate='%s'", impersonate)
            try:
                sess = self._get_session(impersonate)

                # Получаем токен
                try:
                    self._refresh_token(sess, impersonate)
                except RuntimeError as exc:
                    logger.warning("Ошибка токена (%s): %s. Пробуем без токена.", impersonate, exc)
                    self._token = None

                # Warm-up
                if not self.skip_warmup:
                    self._do_warmup(sess, impersonate, kind, doc_id, referer)

                # Перебираем API-эндпоинты
                candidates = _build_api_candidates(kind, doc_id)
                for label, api_url in candidates:
                    logger.debug("Запрос [%s]: %s", label, api_url)
                    try:
                        h = _build_browser_headers(
                            referer,
                            accept_json=True,
                            bearer_token=self._token,
                        )
                        h["User-Agent"] = self.user_agent
                        resp = self._do_get(sess, api_url, headers=h, impersonate=impersonate)
                        status = int(getattr(resp, "status_code", 0) or 0)
                        logger.debug("  → HTTP %d", status)
                        if status != 200:
                            continue
                        txt = getattr(resp, "text", "") or ""
                        if not txt.strip():
                            continue
                        try:
                            obj = resp.json()
                        except Exception:
                            try:
                                obj = json.loads(txt)
                            except Exception:
                                logger.debug("  → Не удалось декодировать JSON")
                                continue
                        if isinstance(obj, (dict, list)) and obj:
                            logger.debug("  → Успешно получен JSON (%d байт)", len(txt))
                            return obj
                    except Exception as exc:
                        logger.debug("  → Ошибка запроса %s: %s", api_url, exc)
                        continue

            except Exception as exc:
                logger.warning("Ошибка для impersonate='%s': %s", impersonate, exc)
                # Сбрасываем сессию для следующей попытки
                self._session = None
                self._token = None
                continue

        logger.warning(
            "Все попытки для %s ID=%s провалились",
            kind, doc_id,
        )
        return None

    # ------------------------------------------------------------------
    # Публичные методы
    # ------------------------------------------------------------------

    def get_certificate(self, cert_id: str) -> Optional[Dict]:
        """
        Получает сырой JSON сертификата по числовому ID.

        Параметры:
            cert_id — строка с числовым ID (например '2406631')

        Возвращает dict с данными или None при ошибке.
        """
        cert_id = str(cert_id).strip()
        if not cert_id.isdigit():
            logger.error("get_certificate: '%s' не является числовым ID", cert_id)
            return None
        raw = self._fetch_raw("rss_certificate", cert_id)
        return raw if isinstance(raw, dict) else None

    def get_declaration(self, decl_id: str) -> Optional[Dict]:
        """
        Получает сырой JSON декларации по числовому ID.

        Параметры:
            decl_id — строка с числовым ID

        Возвращает dict с данными или None при ошибке.
        """
        decl_id = str(decl_id).strip()
        if not decl_id.isdigit():
            logger.error("get_declaration: '%s' не является числовым ID", decl_id)
            return None
        raw = self._fetch_raw("rds_declaration", decl_id)
        return raw if isinstance(raw, dict) else None

    def parse_fsa_full(self, url: str) -> Dict[str, str]:
        """
        Главный публичный метод.

        Принимает URL вида:
          https://pub.fsa.gov.ru/rss/certificate/view/{id}/baseInfo
          https://pub.fsa.gov.ru/rds/declaration/view/{id}/common

        Возвращает плоский dict со ВСЕМИ извлечёнными полями.
        При ошибке возвращает dict с ключом 'error'.

        Результат кэшируется на cache_ttl секунд.
        """
        kind, doc_id = extract_fsa_kind_and_id(url)
        if not kind or not doc_id:
            logger.error("parse_fsa_full: не удалось определить тип/ID из URL: %s", url)
            return {
                "error": f"Не распознан FSA URL: {url}",
                "source": f"fsa_enhanced:error:{url}",
            }

        cache_key = f"{kind}:{doc_id}"
        now = time.time()

        # Проверяем кэш
        if cache_key in self._cache:
            ts, cached_result = self._cache[cache_key]
            if now - ts < self.cache_ttl:
                logger.debug("Возврат из кэша для %s", cache_key)
                return dict(cached_result)

        # Получаем сырые данные
        raw = self._fetch_raw(kind, doc_id)
        if raw is None:
            error_result = {
                "doc_type": "Сертификат" if kind == "rss_certificate" else "Декларация",
                "doc_id": doc_id,
                "error": "Не удалось получить данные (все попытки провалились)",
                "source": f"fsa_enhanced:error:{url}",
            }
            return error_result

        # Парсим поля
        extractor = FSAFieldExtractor(raw, kind=kind, doc_id=doc_id, source_url=url)
        result = extractor.extract()

        if not result.get("doc_number"):
            logger.warning(
                "parse_fsa_full: doc_number не найден для %s %s, "
                "данные могут быть неполными",
                kind, doc_id,
            )

        # Сохраняем в кэш
        self._cache[cache_key] = (now, dict(result))
        return result

    def clear_cache(self) -> None:
        """Очищает внутренний кэш результатов."""
        self._cache.clear()
        logger.debug("Кэш FSAEnhancedClient очищен")


# ---------------------------------------------------------------------------
# Вспомогательная функция для совместимости с main_v39.py
# ---------------------------------------------------------------------------

def parse_fsa_enhanced(
    url: str,
    *,
    timeout: float = 12.0,
    skip_warmup: bool = False,
) -> Dict[str, str]:
    """
    Быстрая обёртка для разового вызова без создания объекта FSAEnhancedClient.

    Эквивалент:
        client = FSAEnhancedClient(timeout=timeout, skip_warmup=skip_warmup)
        return client.parse_fsa_full(url)

    Использование из main_v39.py:
        from fsa_enhanced import parse_fsa_enhanced
        fields = parse_fsa_enhanced(fsa_url)
        if 'doc_number' in fields:
            print(fields['doc_number'])
    """
    client = FSAEnhancedClient(timeout=timeout, skip_warmup=skip_warmup)
    return client.parse_fsa_full(url)


# ---------------------------------------------------------------------------
# CLI / smoke-тест
# ---------------------------------------------------------------------------

def _print_result(result: Dict[str, str], *, as_json: bool = True) -> None:
    """Выводит результат в stdout."""
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        # Табличный вывод
        max_key = max((len(k) for k in result), default=20)
        for k, v in result.items():
            lines = str(v).split("\n")
            print(f"  {k:<{max_key}} : {lines[0]}")
            for line in lines[1:]:
                print(f"  {' ' * max_key}   {line}")


def main() -> None:
    """
    CLI точка входа.

    Использование:
        python fsa_enhanced.py <URL> [--table] [--verbose] [--no-warmup]

    Аргументы:
        <URL>        — URL документа ФСА (сертификат или декларация)
        --table      — вывод в табличном формате вместо JSON
        --verbose    — подробный лог (DEBUG)
        --no-warmup  — пропустить warm-up запросы (быстрее)

    Примеры:
        python fsa_enhanced.py https://pub.fsa.gov.ru/rss/certificate/view/2406631/baseInfo
        python fsa_enhanced.py https://pub.fsa.gov.ru/rds/declaration/view/12345/common --table
        python fsa_enhanced.py https://pub.fsa.gov.ru/rss/certificate/view/2406631/baseInfo --no-warmup --verbose
    """
    args = sys.argv[1:]

    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        print("\nИспользование:")
        print("  python fsa_enhanced.py <URL> [--table] [--verbose] [--no-warmup]")
        sys.exit(0)

    # Парсинг аргументов
    url = None
    as_table = False
    verbose = False
    no_warmup = False

    for arg in args:
        if arg.startswith("http"):
            url = arg
        elif arg == "--table":
            as_table = True
        elif arg in ("--verbose", "-v"):
            verbose = True
        elif arg == "--no-warmup":
            no_warmup = True

    if not url:
        print("Ошибка: не указан URL", file=sys.stderr)
        print("Использование: python fsa_enhanced.py <URL>", file=sys.stderr)
        sys.exit(1)

    # Настраиваем логирование
    log_level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )

    if not _CURL_CFFI_AVAILABLE:
        print(
            "ОШИБКА: curl_cffi не установлен.\n"
            "Установите командой: pip install curl_cffi",
            file=sys.stderr,
        )
        sys.exit(2)

    # Определяем тип документа
    kind, doc_id = extract_fsa_kind_and_id(url)
    if not kind:
        print(f"ОШИБКА: не удалось определить тип документа из URL: {url}", file=sys.stderr)
        sys.exit(3)

    doc_type_str = "Сертификат" if kind == "rss_certificate" else "Декларация"
    print(
        f"Тип: {doc_type_str}, ID: {doc_id}",
        file=sys.stderr,
    )
    print(f"URL: {url}", file=sys.stderr)

    t0 = time.time()
    client = FSAEnhancedClient(timeout=12.0, skip_warmup=no_warmup)
    result = client.parse_fsa_full(url)
    elapsed = time.time() - t0

    print(f"Завершено за {elapsed:.2f} сек, извлечено полей: {len(result)}", file=sys.stderr)

    _print_result(result, as_json=not as_table)


if __name__ == "__main__":
    main()
