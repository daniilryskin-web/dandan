#!/usr/bin/env python3
"""
Развёртка таблицы занятости: обратно к строке на каждый продукт.

Обратная операция к collapse_employees.py. Берёт таблицу, где каждый
сотрудник занимает одну строку, а его продукты пронумерованы в ячейке,
и раскладывает её обратно — по строке на продукт:

    было (1 строка)                    стало (3 строки)
    Продукт (кратко)                   Экспорт (РЭЦ)        Гаспарян А.К.
      1. Экспорт (РЭЦ)          →      Таможня              Гаспарян А.К.
      2. Таможня                       Минюст и нотариат    Горбунова А.В.
      3. Минюст и нотариат
    Руководитель
      1. Гаспарян А.К.
      2. Горбунова А.В.

Запуск:
    python3 expand_employees.py свёрнуто.xlsx
    python3 expand_employees.py свёрнуто.xlsx --out развёрнуто.xlsx

ГЛАВНАЯ СЛОЖНОСТЬ. Свёртка выбрасывает повторы в каждом столбце отдельно.
Три продукта и два руководителя — и из ячейки уже не видно, к кому из двух
относится второй продукт. Угадывать нельзя: ошибка уведёт продукт в чужую
ветку дерева, и заметят это нескоро. Поэтому руководитель (и вместе с ним
ответственный и проект) для каждого продукта определяется так, от точного
к менее точному:

    1. значение одно                — оно у всех продуктов
    2. значений столько же, сколько
       продуктов                    — по порядку: первое к первому
    3. первый продукт               — всегда к первому значению: свёртка
                                      пишет значения в порядке появления
    4. по справочнику               — у кого-то ещё этот продукт стоит
                                      однозначно; берём оттуда, если такое
                                      значение есть у самого сотрудника
    5. не определено                — ячейка остаётся пустой, а строка
                                      попадает на лист «Проверить»

Справочник собирается из самой же таблицы: у сотрудников на одном продукте
и у мультипродуктовых, разложенных точно, связь «продукт → руководитель»
видна напрямую. Продукты, которые где-то стоят у двух разных руководителей,
в справочник не берутся — по ним ответ не однозначен.

Листы на выходе:

    Развёрнуто   вся таблица, по строке на продукт; набор столбцов прежний
    Проверить    ячейки, заполненные по справочнику или не заполненные вовсе
    Сводка       сколько развернулось и как
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd
from openpyxl.utils import get_column_letter

# Столбцы, которые свёртка нумерует. Должны совпадать с collapse_employees.py.
MULTI_COLUMNS = [
    "Ответственный за направление",
    "Непосредственный руководитель",
    "Проект / фукнция",
    "Продукт (кратко)",
    "Продукт",
]

# По каким столбцам продукт узнаётся, от точного к грубому. Полное название
# различает системы внутри одного продукта, поэтому первым идёт оно.
ANCHOR_COLUMNS = ["Продукт", "Продукт (кратко)"]

NAME_COLUMN = "ФИО (штат)"

EMPTY_MARKERS = {"", "-", "—", "–", "nan", "none", "#н/д", "#n/a"}

# «1. Зазыкин В.Г.» — номер, точка, пробел. Снимается только в многострочных
# ячейках: в однострочной это может быть часть названия.
NUMBER_PREFIX = re.compile(r"^\s*\d+\.\s+")


def clean(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value).replace(" ", " ").replace(" ", " ")
    return re.sub(r"[ \t]+", " ", text).strip()


def norm(value) -> str:
    text = clean(value).casefold()
    return "" if text in EMPTY_MARKERS else text


def norm_header(value) -> str:
    return clean(value).casefold()


def find_column(frame: pd.DataFrame, name: str) -> str | None:
    target = norm_header(name)
    return next((c for c in frame.columns if norm_header(c) == target), None)


def parse_cell(value) -> list[str]:
    """Ячейка → список значений.

    Многострочная ячейка — это нумерованный список свёртки: делим по строкам
    и снимаем номера. Однострочная — одно значение как есть. Пустая — пусто.
    Excel при ручной правке ставит то \\n, то \\r\\n, поэтому делим по обоим.
    """
    text = "" if value is None or (isinstance(value, float) and pd.isna(value)) \
        else str(value)
    lines = [clean(line) for line in re.split(r"\r?\n", text)]
    lines = [line for line in lines if line]
    if len(lines) <= 1:
        single = clean(text)
        return [single] if norm(single) else []
    return [NUMBER_PREFIX.sub("", line).strip() for line in lines]


def pick_sheet(path: Path) -> str:
    book = pd.read_excel(path, sheet_name=None, dtype=str, nrows=0)
    # Свёртка пишет таблицу на лист «Все сотрудники»; его и берём, если есть.
    for name in book:
        if norm_header(name) == norm_header("Все сотрудники"):
            return name
    for name, frame in book.items():
        if norm_header(NAME_COLUMN) in {norm_header(c) for c in frame.columns}:
            return name
    sys.exit(
        f"В файле {path} не нашёлся лист со столбцом «{NAME_COLUMN}».\n"
        "Листы: " + ", ".join(book) + "\nУкажите лист явно: --sheet «Название»"
    )


def read_table(path: Path, sheet) -> pd.DataFrame:
    if not path.exists():
        sys.exit(f"Файл не найден: {path}")
    if sheet is None:
        sheet = pick_sheet(path)
    frame = pd.read_excel(path, sheet_name=sheet, dtype=str)
    frame = frame.loc[:, [c for c in frame.columns if not str(c).startswith("Unnamed")]]
    filled = frame.map(clean).ne("").any(axis=1)
    frame = frame[filled].reset_index(drop=True)
    print(f"Прочитано: лист «{sheet}», строк {len(frame)}, столбцов {len(frame.columns)}")
    return frame


def first_pass(frame: pd.DataFrame, multi: list[str], anchors: list[str]):
    """Раскладывает всё, что раскладывается точно. Неясное оставляет None.

    Возвращает список строк-заготовок и список «фактов» — пар
    (продукт → значение столбца), установленных без догадок. Из фактов
    потом собирается справочник для второго прохода.
    """
    drafts, facts = [], []
    name_column = find_column(frame, NAME_COLUMN)

    for source_index, row in frame.iterrows():
        lists = {column: parse_cell(row[column]) for column in multi}

        # Сколько строк получится — по самому подробному продуктовому столбцу.
        anchor = max(anchors, key=lambda c: len(lists[c])) if anchors else None
        count = max([len(lists[anchor])] if anchor else [1])
        count = max(count, 1)

        for i in range(count):
            draft = {"__источник": source_index, "__номер": i, "__как": {}}
            for column in frame.columns:
                if column not in multi:
                    draft[column] = clean(row[column])
                    continue
                values = lists[column]
                if not values:
                    draft[column] = ""
                elif len(values) == 1:
                    draft[column] = values[0]
                elif len(values) == count:
                    draft[column] = values[i]
                elif i == 0:
                    # Свёртка пишет значения в порядке появления: первое
                    # значение пришло из первой строки, а первая строка —
                    # это первый продукт. Здесь ошибиться нельзя.
                    draft[column] = values[0]
                else:
                    draft[column] = None
                    draft["__как"][column] = values
            draft["__якорь"] = anchor
            draft["__ФИО"] = clean(row[name_column]) if name_column else ""
            drafts.append(draft)

            # Всё, что встало точно, — факт для справочника.
            if anchor:
                key = norm(draft[anchor])
                for column in multi:
                    if column in anchors or draft[column] is None:
                        continue
                    if key and norm(draft[column]):
                        facts.append((anchor, key, column, draft[column]))
    return drafts, facts


def build_reference(facts) -> dict:
    """Справочник «продукт → значение». Неоднозначное в него не попадает.

    Если у продукта в разных строках разные руководители (такое бывает:
    продукт поделён между двумя командами), подсказывать по нему нельзя.
    """
    seen: dict[tuple, set] = {}
    spelling: dict[tuple, str] = {}
    for anchor, key, column, value in facts:
        slot = (anchor, key, column)
        seen.setdefault(slot, set()).add(norm(value))
        spelling.setdefault((slot, norm(value)), value)
    reference = {}
    for slot, variants in seen.items():
        if len(variants) == 1:
            only = next(iter(variants))
            reference[slot] = spelling[(slot, only)]
    return reference


def second_pass(drafts, reference) -> list[dict]:
    """Дозаполняет неясные ячейки по справочнику, остальное отдаёт на проверку."""
    to_check = []
    for draft in drafts:
        for column, options in draft["__как"].items():
            anchor = draft["__якорь"]
            product = draft.get(anchor, "")
            hint = reference.get((anchor, norm(product), column))
            allowed = {norm(o): o for o in options}

            if hint and norm(hint) in allowed:
                draft[column] = allowed[norm(hint)]
                how = "по справочнику"
            else:
                draft[column] = ""
                how = "не определено — заполнить вручную"

            to_check.append({
                "ФИО": draft["__ФИО"],
                "Продукт": product,
                "Столбец": column,
                "Подставлено": draft[column],
                "Варианты у сотрудника": " | ".join(options),
                "Как определено": how,
            })
    return to_check


def autosize(writer, sheet_name: str, frame: pd.DataFrame) -> None:
    sheet = writer.sheets[sheet_name]
    for position, column in enumerate(frame.columns, 1):
        longest = max(
            [len(str(column))] + [len(str(v)) for v in frame[column].head(400)]
        )
        sheet.column_dimensions[get_column_letter(position)].width = min(
            max(longest + 2, 10), 45
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("source", type=Path, help="свёрнутая таблица")
    parser.add_argument("--out", type=Path, default=Path("развёрнуто.xlsx"))
    parser.add_argument("--sheet", default=None, help="лист в исходнике")
    args = parser.parse_args()

    frame = read_table(args.source, args.sheet)
    multi = [c for c in (find_column(frame, m) for m in MULTI_COLUMNS) if c]
    anchors = [c for c in (find_column(frame, a) for a in ANCHOR_COLUMNS) if c]
    if not anchors:
        sys.exit("В таблице нет ни «Продукт», ни «Продукт (кратко)» — разворачивать нечего")

    drafts, facts = first_pass(frame, multi, anchors)
    reference = build_reference(facts)
    to_check = second_pass(drafts, reference)

    expanded = pd.DataFrame(
        [{c: d[c] for c in frame.columns} for d in drafts], columns=list(frame.columns)
    )
    check = pd.DataFrame(to_check)

    sources = pd.Series([d["__источник"] for d in drafts])
    grown = sources.value_counts()
    unresolved = int((check["Как определено"] != "по справочнику").sum()) if len(check) else 0

    summary = [
        ("Строк в свёрнутой таблице", len(frame)),
        ("Строк после развёртки", len(expanded)),
        ("Сотрудников развёрнуто в несколько строк", int((grown > 1).sum())),
        ("Ячеек заполнено по справочнику", len(check) - unresolved),
        ("Ячеек не определено — заполнить вручную", unresolved),
    ]

    with pd.ExcelWriter(args.out, engine="openpyxl") as writer:
        pd.DataFrame(summary, columns=["Показатель", "Значение"]).to_excel(
            writer, sheet_name="Сводка", index=False
        )
        expanded.to_excel(writer, sheet_name="Развёрнуто", index=False)
        autosize(writer, "Развёрнуто", expanded)
        (check if len(check) else pd.DataFrame(
            [{"Результат": "Всё разложилось точно, проверять нечего"}]
        )).to_excel(writer, sheet_name="Проверить", index=False)

    print()
    for name, value in summary:
        print(f"{name}: {value}")
    if unresolved:
        print("\nНе удалось определить — эти ячейки пустые, заполните по листу «Проверить»:")
        for _, row in check[check["Как определено"] != "по справочнику"].head(10).iterrows():
            print(f"  · {row['ФИО']} / {row['Продукт']} — {row['Столбец']}: "
                  f"варианты {row['Варианты у сотрудника']}")
    print(f"\nЗаписано: {args.out}")


if __name__ == "__main__":
    main()
