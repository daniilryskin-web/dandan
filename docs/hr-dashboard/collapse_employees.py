#!/usr/bin/env python3
"""
Свёртка таблицы занятости: один сотрудник — одна строка.

В исходнике на каждый продукт приходится своя строка, поэтому человек,
занятый в семи продуктах, занимает семь строк. Отличаются они продуктом
и, если человек работает у разных руководителей, ещё тремя столбцами:
ответственный за направление, непосредственный руководитель, проект.

Скрипт собирает такие строки в одну. Значения, которые внутри сотрудника
действительно разные, складываются в одну ячейку и нумеруются:

    Ответственный за направление   1. Зазыкин В.Г.
                                   2. Радужан А.А.
    Продукт (кратко)               1. Экспорт (РЭЦ)
                                   2. Таможня
                                   3. Минюст и нотариат

Если значение по сотруднику одно и то же, оно остаётся как есть, без
номера: нумеровать единственное значение незачем.

Запуск:
    python3 collapse_employees.py таблица.xlsx
    python3 collapse_employees.py таблица.xlsx --out свёрнуто.xlsx

Листы на выходе:

    Все сотрудники    вся таблица, по строке на человека; вакансии как были
    Мультипродуктовые только те, кто занимал несколько строк
    Расхождения       столбцы, которые должны были совпадать, но не совпали
    Сводка            сколько строк свернулось и во что

ВАКАНСИИ НЕ ТРОГАЕМ. Строка без ФИО (или с пометкой «вакансия» в зарплате) —
это открытая позиция, а не человек; такие строки переносятся в результат
как есть, по одной.

ОСТАЛЬНЫЕ СТОЛБЦЫ — организация, роль, должность, зарплата и прочее —
по строкам одного человека обязаны совпадать, поэтому берётся первое
значение. Если они всё же разошлись, строка не склеивается молча:
расхождение попадает на отдельный лист. Именно так ловится, например,
одна и та же фамилия с двумя разными зарплатами.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd
from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter

# Столбцы, значения которых у одного человека могут законно различаться.
# Они и нумеруются. Всё остальное должно совпадать.
MULTI_COLUMNS = [
    "Ответственный за направление",
    "Непосредственный руководитель",
    "Проект / фукнция",
    "Продукт (кратко)",
    "Продукт",
]

NAME_COLUMN = "ФИО (штат)"
SALARY_COLUMN = "Текущая ЗП, gross"
VACANCY_MARKER = "вакансия"

# Номер строки у свёрнутого сотрудника берётся от первой его строки.
ROW_NUMBER_COLUMN = "№"

EMPTY_MARKERS = {"", "-", "—", "–", "nan", "none", "#н/д", "#n/a"}


def clean(value) -> str:
    """Текст без лишних и неразрывных пробелов."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value).replace(" ", " ").replace(" ", " ")
    return re.sub(r"[ \t]+", " ", text).strip()


def norm(value) -> str:
    """Значение для сравнения: без регистра, пустые маркеры — к пустому."""
    text = clean(value).casefold()
    return "" if text in EMPTY_MARKERS else text


def norm_header(value) -> str:
    return clean(value).casefold()


def find_column(frame: pd.DataFrame, name: str) -> str | None:
    """Заголовок в таблице, совпадающий с нужным без учёта регистра."""
    target = norm_header(name)
    return next((c for c in frame.columns if norm_header(c) == target), None)


def pick_sheet(path: Path) -> str:
    book = pd.read_excel(path, sheet_name=None, dtype=str, nrows=0)
    for name, frame in book.items():
        if norm_header(NAME_COLUMN) in {norm_header(c) for c in frame.columns}:
            return name
    sys.exit(
        f"В файле {path} не нашёлся лист со столбцом «{NAME_COLUMN}».\n"
        "Листы: " + ", ".join(book) + "\nУкажите лист явно: --sheet «Название»"
    )


def read_table(path: Path, sheet: str | int | None) -> pd.DataFrame:
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


def numbered(values: list[str]) -> str:
    """Одно значение — как есть; несколько — списком с номерами."""
    if len(values) == 1:
        return values[0]
    return "\n".join(f"{i}. {value}" for i, value in enumerate(values, 1))


def unique_in_order(series) -> list[str]:
    """Непустые значения без повторов, в порядке появления в файле."""
    seen, out = set(), []
    for value in series:
        text = clean(value)
        key = norm(value)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def is_vacancy(row: pd.Series, name_column: str, salary_column: str | None) -> bool:
    """Открытая позиция: нет ФИО либо в зарплате написано «вакансия»."""
    if not norm(row[name_column]):
        return True
    if salary_column and VACANCY_MARKER in norm(row[salary_column]):
        return True
    return False


def collapse(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, list]:
    """Сворачивает строки одного сотрудника в одну.

    Возвращает свёрнутую таблицу, список расхождений по столбцам, которые
    должны были совпадать, и перечень свёрнутых сотрудников.
    """
    name_column = find_column(frame, NAME_COLUMN)
    if name_column is None:
        sys.exit(f"В таблице нет столбца «{NAME_COLUMN}»")
    salary_column = find_column(frame, SALARY_COLUMN)

    multi = [c for c in (find_column(frame, m) for m in MULTI_COLUMNS) if c]
    missing = [m for m in MULTI_COLUMNS if find_column(frame, m) is None]
    if missing:
        print("Внимание: столбцов нет в таблице, нумероваться не будут: "
              + ", ".join(missing))

    vacancy_mask = frame.apply(
        lambda row: is_vacancy(row, name_column, salary_column), axis=1
    )
    people = frame[~vacancy_mask]
    vacancies = frame[vacancy_mask]

    rows, conflicts, collapsed_names = [], [], []
    # groupby по нормализованному ФИО, но сортировку не включаем: порядок
    # строк в результате должен совпадать с порядком в исходнике.
    key = people[name_column].map(norm)
    for _, block in people.groupby(key, sort=False):
        first = block.iloc[0]
        record = {}
        for column in frame.columns:
            if column in multi:
                record[column] = numbered(unique_in_order(block[column]))
                continue
            values = unique_in_order(block[column])
            record[column] = values[0] if values else ""
            # Столбец должен был совпадать по всем строкам человека.
            # Номер строки — законное исключение, он у каждой строки свой.
            if len(values) > 1 and norm_header(column) != norm_header(ROW_NUMBER_COLUMN):
                conflicts.append({
                    "ФИО": clean(first[name_column]),
                    "Столбец": column,
                    "Значений": len(values),
                    "Какие": " | ".join(values),
                    "Строк у сотрудника": len(block),
                })
        rows.append(record)
        if len(block) > 1:
            collapsed_names.append((clean(first[name_column]), len(block)))

    collapsed = pd.DataFrame(rows, columns=list(frame.columns))

    # Вакансии возвращаем как были, ничего не склеивая.
    if not vacancies.empty:
        kept = vacancies.map(clean)
        collapsed = pd.concat([collapsed, kept], ignore_index=True)

    return collapsed, pd.DataFrame(conflicts), collapsed_names


def autosize(writer, sheet_name: str, frame: pd.DataFrame) -> None:
    """Перенос по словам в многострочных ячейках и вменяемая ширина столбцов."""
    sheet = writer.sheets[sheet_name]
    for position, column in enumerate(frame.columns, 1):
        longest = max(
            [len(str(column))]
            + [max((len(part) for part in str(v).split("\n")), default=0)
               for v in frame[column].head(400)]
        )
        sheet.column_dimensions[get_column_letter(position)].width = min(
            max(longest + 2, 10), 45
        )
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            if isinstance(cell.value, str) and "\n" in cell.value:
                cell.alignment = Alignment(wrap_text=True, vertical="top")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("source", type=Path, help="исходная таблица занятости")
    parser.add_argument("--out", type=Path, default=Path("свёрнуто.xlsx"))
    parser.add_argument("--sheet", default=None, help="лист в исходнике")
    args = parser.parse_args()

    frame = read_table(args.source, args.sheet)
    collapsed, conflicts, collapsed_names = collapse(frame)

    name_column = find_column(collapsed, NAME_COLUMN)
    multi_names = {name for name, _ in collapsed_names}
    only_multi = collapsed[collapsed[name_column].map(clean).isin(multi_names)]

    named = collapsed[name_column].map(norm) != ""
    summary = [
        ("Строк в исходнике", len(frame)),
        ("Строк после свёртки", len(collapsed)),
        ("Уникальных сотрудников", int(named.sum())),
        ("Вакансий (перенесены как есть)", int((~named).sum())),
        ("Сотрудников на нескольких продуктах", len(collapsed_names)),
        ("Строк, которые они занимали", sum(n for _, n in collapsed_names)),
        ("Максимум строк на одного", max((n for _, n in collapsed_names), default=0)),
        ("Расхождений в столбцах, которые должны совпадать", len(conflicts)),
    ]

    with pd.ExcelWriter(args.out, engine="openpyxl") as writer:
        pd.DataFrame(summary, columns=["Показатель", "Значение"]).to_excel(
            writer, sheet_name="Сводка", index=False
        )
        collapsed.to_excel(writer, sheet_name="Все сотрудники", index=False)
        autosize(writer, "Все сотрудники", collapsed)

        if len(only_multi):
            only_multi.to_excel(writer, sheet_name="Мультипродуктовые", index=False)
            autosize(writer, "Мультипродуктовые", only_multi)
        else:
            pd.DataFrame([{"Результат": "Таких сотрудников нет"}]).to_excel(
                writer, sheet_name="Мультипродуктовые", index=False
            )

        (conflicts if not conflicts.empty else pd.DataFrame(
            [{"Результат": "Все столбцы, которые должны совпадать, совпали"}]
        )).to_excel(writer, sheet_name="Расхождения", index=False)

    print()
    for name, value in summary:
        print(f"{name}: {value}")
    if not conflicts.empty:
        print("\nСтолбцы разошлись внутри сотрудника — смотрите лист «Расхождения»:")
        for _, row in conflicts.head(10).iterrows():
            print(f"  · {row['ФИО']} — {row['Столбец']}: {row['Какие']}")
    print(f"\nЗаписано: {args.out}")


if __name__ == "__main__":
    main()
