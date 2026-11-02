#!/usr/bin/env python3
"""
Развёртка таблицы занятости: обратно к строке на каждый продукт.

Обратная операция к collapse_employees.py. Берёт таблицу, где каждый
сотрудник занимает одну строку, а его продукты пронумерованы в ячейке,
и раскладывает её обратно — по строке на продукт.

Запуск:
    python expand_employees.py свёрнуто.xlsx
    python expand_employees.py свёрнуто.xlsx --out развёрнуто.xlsx

ПРАВИЛО ПРОСТОЕ.

    Продукт, Продукт (кратко)      каждый пункт списка — своя строка

    Ответственный за направление   значение одно — оно во всех строках;
    Непосредственный руководитель  значений несколько — в ячейке остаются
    Проект / фукнция               все варианты, каждый с новой строки,
                                   ячейка подсвечена жёлтым; лишнее
                                   удаляется вручную

Почему не выбираем сами. Свёртка выбрасывает повторы в каждом столбце
отдельно, и при трёх продуктах и двух руководителях из ячейки уже не
видно, какой продукт у какого руководителя. Подставлять наугад нельзя:
ошибка уведёт продукт в чужую ветку дерева. Поэтому все варианты остаются
на месте, а правильный оставляет человек.

Номера («1.», «2.») в таких ячейках снимаются: удалили лишнюю строку —
осталось чистое значение, без хвоста «2.».

Листы на выходе:

    Развёрнуто   вся таблица, по строке на продукт; где выбрать — жёлтым
    Проверить    те же ячейки списком
    Сводка       сколько развернулось и сколько ячеек проверить
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd
from openpyxl.styles import Alignment, PatternFill
from openpyxl.utils import get_column_letter

# Продуктовые столбцы: по ним строится число строк, каждый пункт — строка.
# Полное название идёт первым: оно различает системы внутри одного продукта.
PRODUCT_COLUMNS = ["Продукт", "Продукт (кратко)"]

# Столбцы «где работает». Одно значение размножается на все строки,
# несколько — оставляются пустыми под ручное заполнение.
ORG_COLUMNS = [
    "Ответственный за направление",
    "Непосредственный руководитель",
    "Проект / фукнция",
]

NAME_COLUMN = "ФИО (штат)"

EMPTY_MARKERS = {"", "-", "—", "–", "nan", "none", "#н/д", "#n/a"}

# «1. Зазыкин В.Г.» — номер, точка, пробел. Снимается только в многострочных
# ячейках: в однострочной это может оказаться частью названия.
NUMBER_PREFIX = re.compile(r"^\s*\d+\.\s+")

FILL_ME = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")


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

    Многострочная ячейка — нумерованный список свёртки: делим по строкам
    и снимаем номера. Однострочная — одно значение как есть.
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


def expand(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[dict], list[tuple]]:
    """Раскладывает свёрнутые строки по продуктам.

    Возвращает развёрнутую таблицу, список ячеек к заполнению (для листа
    «Заполнить») и их координаты (для жёлтой подсветки).
    """
    products = [c for c in (find_column(frame, p) for p in PRODUCT_COLUMNS) if c]
    orgs = [c for c in (find_column(frame, o) for o in ORG_COLUMNS) if c]
    if not products:
        sys.exit("В таблице нет ни «Продукт», ни «Продукт (кратко)» — разворачивать нечего")
    name_column = find_column(frame, NAME_COLUMN)
    number_column = find_column(frame, "№")

    rows, to_fill, cells = [], [], []
    for _, row in frame.iterrows():
        lists = {c: parse_cell(row[c]) for c in products + orgs}
        count = max([len(lists[c]) for c in products] + [1])

        for i in range(count):
            record = {}
            for column in frame.columns:
                if column in products:
                    values = lists[column]
                    if len(values) == count:
                        record[column] = values[i]
                    elif len(values) <= 1:
                        record[column] = values[0] if values else ""
                    else:
                        # Продуктов в двух столбцах разное число и не одно —
                        # например две короткие на три полных. Какое к какому,
                        # не видно, поэтому тоже руками.
                        record[column] = None
                elif column in orgs:
                    values = lists[column]
                    record[column] = values[0] if len(values) == 1 else (
                        "" if not values else None
                    )
                else:
                    record[column] = clean(row[column])

            for column, value in record.items():
                if value is not None:
                    continue
                options = lists[column]
                # Все варианты остаются в ячейке, каждый с новой строки и без
                # номера: удалили лишнее — осталось чистое значение.
                record[column] = "\n".join(options)
                to_fill.append({
                    "№": clean(row[number_column]) if number_column else "",
                    "ФИО": clean(row[name_column]) if name_column else "",
                    "Продукт": record.get(products[0], ""),
                    "Столбец": column,
                    "Варианты": " | ".join(options),
                })
                cells.append((len(rows), column))
            rows.append(record)

    expanded = pd.DataFrame(rows, columns=list(frame.columns))
    return expanded, to_fill, cells


def autosize(sheet, frame: pd.DataFrame) -> None:
    for position, column in enumerate(frame.columns, 1):
        longest = max([len(str(column))] + [len(str(v)) for v in frame[column].head(400)])
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
    expanded, to_fill, cells = expand(frame)

    people_to_fill = len({item["ФИО"] for item in to_fill})
    summary = [
        ("Строк в свёрнутой таблице", len(frame)),
        ("Строк после развёртки", len(expanded)),
        ("Ячеек с выбором — оставить нужное", len(to_fill)),
        ("У скольких сотрудников", people_to_fill),
    ]

    with pd.ExcelWriter(args.out, engine="openpyxl") as writer:
        pd.DataFrame(summary, columns=["Показатель", "Значение"]).to_excel(
            writer, sheet_name="Сводка", index=False
        )
        expanded.to_excel(writer, sheet_name="Развёрнуто", index=False)
        sheet = writer.sheets["Развёрнуто"]
        autosize(sheet, expanded)

        # Жёлтым — ровно те ячейки, где надо оставить один вариант.
        # Перенос по словам, иначе варианты слипнутся в одну строку.
        # +2: строка заголовка и нумерация Excel с единицы.
        positions = {c: i + 1 for i, c in enumerate(expanded.columns)}
        for row_index, column in cells:
            cell = sheet.cell(row=row_index + 2, column=positions[column])
            cell.fill = FILL_ME
            cell.alignment = Alignment(wrap_text=True, vertical="top")

        (pd.DataFrame(to_fill) if to_fill else pd.DataFrame(
            [{"Результат": "Всё разложилось однозначно, проверять нечего"}]
        )).to_excel(writer, sheet_name="Проверить", index=False)
        autosize(writer.sheets["Проверить"], pd.DataFrame(to_fill) if to_fill
                 else pd.DataFrame(columns=["Результат"]))

    print()
    for name, value in summary:
        print(f"{name}: {value}")
    if to_fill:
        print("\nГде несколько вариантов — ячейки жёлтые на листе «Развёрнуто»: "
              "оставьте нужный, остальные удалите. Списком — на листе «Проверить».")
    print(f"\nЗаписано: {args.out}")


if __name__ == "__main__":
    main()
