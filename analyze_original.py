#!/usr/bin/env python3
"""
Помощник: вычисляет бит маски viewFlags, отвечающий за плашку «Оригинал».

Зачем: на WB признак «Оригинал» — это бит в числе viewFlags (есть в карточке
card.wb.ru). По одной паре товаров «с Оригиналом» / «без» получается несколько
кандидатов; чем больше товаров, тем точнее изолируется нужный бит.

КАК ПОЛЬЗОВАТЬСЯ (запускать на машине, где открывается WB):

    python analyze_original.py --orig 863239425,НМ2,НМ3 --plain 1008983494,НМ5,НМ6

  --orig   : артикулы товаров, у которых ТОЧНО ЕСТЬ плашка «Оригинал»
  --plain  : артикулы товаров, у которых плашки «Оригинал» НЕТ

Чем больше артикулов в каждом списке (по 3-5), тем надёжнее. Скрипт скачает
viewFlags каждого и напечатает кандидатов. Если останется один — это и есть
искомый бит; впишите его в main_v39.py: WB_ORIGINAL_VIEWFLAG_BIT = <значение>.
(или просто пришлите мне вывод этого скрипта.)
"""
import argparse
import json
import sys
import urllib.request
from typing import Dict, List

DETAIL_URL = ("https://card.wb.ru/cards/v4/detail"
              "?appType=1&curr=rub&dest=-1257786&spp=30&nm={nms}")


def fetch_viewflags(nm_ids: List[int]) -> Dict[int, int]:
    """Возвращает {nm_id: viewFlags} для списка артикулов (батчами по 100)."""
    out: Dict[int, int] = {}
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0 Safari/537.36"),
        "Accept": "application/json",
    }
    for i in range(0, len(nm_ids), 100):
        chunk = nm_ids[i:i + 100]
        url = DETAIL_URL.format(nms=";".join(str(n) for n in chunk))
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            print(f"[!] Ошибка запроса для {chunk}: {e}")
            continue
        products = (data.get("products") or data.get("data", {}).get("products") or [])
        for p in products:
            nm = int(p.get("id") or p.get("nmId") or 0)
            vf = p.get("viewFlags")
            if nm and isinstance(vf, int):
                out[nm] = vf
    return out


def bits_of(n: int) -> set:
    return {i for i in range(40) if n & (1 << i)}


def parse_ids(s: str) -> List[int]:
    return [int(x) for x in s.replace(";", ",").split(",") if x.strip().isdigit()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--orig", required=True, help="артикулы С плашкой «Оригинал» через запятую")
    ap.add_argument("--plain", required=True, help="артикулы БЕЗ плашки «Оригинал» через запятую")
    args = ap.parse_args()

    orig_ids = parse_ids(args.orig)
    plain_ids = parse_ids(args.plain)
    if not orig_ids or not plain_ids:
        print("Нужны оба списка: --orig и --plain")
        return 2

    print(f"Скачиваю viewFlags: {len(orig_ids)} с Оригиналом, {len(plain_ids)} без…")
    vf = fetch_viewflags(orig_ids + plain_ids)

    orig_vf = {nm: vf[nm] for nm in orig_ids if nm in vf}
    plain_vf = {nm: vf[nm] for nm in plain_ids if nm in vf}
    print("\nviewFlags «Оригинал»:")
    for nm, v in orig_vf.items():
        print(f"  {nm}: {v}  биты={sorted(bits_of(v))}")
    print("viewFlags «Обычные»:")
    for nm, v in plain_vf.items():
        print(f"  {nm}: {v}  биты={sorted(bits_of(v))}")

    if not orig_vf or not plain_vf:
        print("\n[!] Не удалось получить viewFlags — проверьте доступ к card.wb.ru.")
        return 1

    # Бит «Оригинал»: установлен у ВСЕХ оригинальных и НИ У ОДНОГО обычного.
    common_in_orig = set.intersection(*[bits_of(v) for v in orig_vf.values()])
    any_in_plain = set.union(*[bits_of(v) for v in plain_vf.values()])
    candidates = sorted(common_in_orig - any_in_plain)

    print("\n" + "=" * 60)
    if not candidates:
        print("Кандидатов нет — возможно, «Оригинал» это НЕ бит viewFlags,")
        print("либо в выборке есть ошибка (товар без плашки попал в --orig).")
    elif len(candidates) == 1:
        b = candidates[0]
        print(f"✅ НАЙДЕН БИТ «Оригинал»: бит {b}, значение {1 << b}")
        print(f"   Впишите в main_v39.py:  WB_ORIGINAL_VIEWFLAG_BIT = {1 << b}")
    else:
        vals = [(b, 1 << b) for b in candidates]
        print(f"Осталось несколько кандидатов: {vals}")
        print("Добавьте ещё артикулов в --plain (обычные товары) — это уберёт лишние.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
