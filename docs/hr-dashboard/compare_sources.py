#!/usr/bin/env python3
"""
Сверка двух версий исходной таблицы занятости.

Моя таблица и таблица кадровой службы расходятся: она актуализирует состав,
зарплаты, вакансии и кандидатов. Скрипт показывает ВСЕ расхождения между
двумя файлами, чтобы их можно было пройти глазами и перенести в свою чистую
таблицу — ту, которая потом идёт в дашборд.

Запуск:
    python3 compare_sources.py моя.xlsx кадры.xlsx
    python3 compare_sources.py моя.xlsx кадры.xlsx --out сверка.xlsx

Что получается — книга с пятью листами:

    Сводка        сколько чего разошлось, в одну страницу
    Изменения     построчно: что за человек, какой столбец, было → стало
    Добавлено     строки, которых у меня нет (в моём порядке столбцов)
    Удалено       строки, которых нет у неё
    Столбцы       какие столбцы есть только в одном из файлов

Лист «Изменения» — главный: по нему и идёт верификация. В каждой строке
один изменившийся столбец одного назначения, поэтому решение принимается
по одной ячейке за раз, а не «что-то поменялось в этой строке».

КАК СОПОСТАВЛЯЮТСЯ СТРОКИ. Номер строки (столбец «№») ключом не берётся:
при актуализации строки вставляют, удаляют и пересортировывают, и номера
разъезжаются. Сопоставление идёт в три прохода, от строгого к мягкому:

    1. проект + продукт + роль + ФИО   — одно и то же назначение
    2. проект + продукт + роль         — на место пришёл другой человек
                                         (закрыли вакансию, заменили)
    3. ФИО                             — человека перевели на другой
                                         продукт или роль

Что не сопоставилось ни одним проходом — это «Добавлено» и «Удалено».

Сравнение не придирается к мелочам: лишние пробелы, неразрывный пробел,
регистр и разный формат чисел («120 000,00» и «120000») расхождением
не считаются. Иначе лист превратится в список опечаток, и настоящие
изменения в нём потеряются.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

# Столбцы, по которым строки опознаются. Порядок проходов — от строгого
# к мягкому; на каждом следующем ключ короче, поэтому пара находится даже
# тогда, когда человека заменили или перевели.
MATCH_STAGES = [
    (["Проект / фукнция", "Продукт (кратко)", "Роль", "ФИО (штат)"], "то же назначение"),
    (["Проект / фукнция", "Продукт (кратко)", "Роль"], "замена человека"),
    (["ФИО (штат)"], "перевод"),
]

# Столбцы, расхождение по которым важнее остальных: деньги, человек, роль.
# Попадают в начало листа «Изменения» и помечаются в столбце «Важность».
IMPORTANT = {
    "Текущая ЗП, gross", "ФОТ", "ФИО (штат)", "Роль",
    "Должность", "Кандидат", "Организация",
}

# Значения, которые означают «пусто». Без этого «-» в одном файле и пустая
# ячейка в другом дадут ложное расхождение в каждой второй строке.
EMPTY_MARKERS = {"", "-", "—", "–", "n/a", "na", "нет данных", "#н/д", "#n/a", "nan", "none"}

# Как называется столбец с ФИО — нужен, чтобы опознать лист с данными
# и подписать строки на листе «Изменения».
NAME_COLUMN = "ФИО (штат)"


def clean(value) -> str:
    """Текст без лишних пробелов. Неразрывный пробел приводится к обычному."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value).replace(" ", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def norm_header(value) -> str:
    """Заголовок для сопоставления столбцов между файлами: без регистра."""
    return clean(value).casefold()


def as_number(text: str):
    """Число, если ячейка — число в любом из привычных написаний.

    «120 000,00», «120000.0» и «120000» — одна и та же сумма, и показывать
    их как расхождение незачем. Если разобрать не вышло, возвращается None
    и сравнение идёт как по тексту.
    """
    stripped = text.replace(" ", "").replace(",", ".")
    if not re.fullmatch(r"[-+]?\d*\.?\d+", stripped):
        return None
    try:
        return round(float(stripped), 2)
    except ValueError:
        return None


def norm_value(value) -> str:
    """Значение для сравнения: пустое к пустому, числа к числам, без регистра."""
    text = clean(value)
    if text.casefold() in EMPTY_MARKERS:
        return ""
    number = as_number(text)
    if number is not None:
        # Целые показываем без хвоста, иначе 120000 и 120000.0 разойдутся.
        return str(int(number)) if number == int(number) else str(number)
    return text.casefold()


def pick_sheet(path: Path) -> str:
    """Лист с данными — первый, где в заголовках есть столбец с ФИО."""
    book = pd.read_excel(path, sheet_name=None, dtype=str, nrows=0)
    for name, frame in book.items():
        if norm_header(NAME_COLUMN) in {norm_header(c) for c in frame.columns}:
            return name
    sys.exit(
        f"В файле {path} не нашёлся лист со столбцом «{NAME_COLUMN}».\n"
        "Листы в файле: " + ", ".join(book) + "\n"
        "Укажите лист явно: --sheet «Название листа»"
    )


def read_table(path: Path, sheet: str | int | None, label: str) -> pd.DataFrame:
    """Читает таблицу как текст и запоминает номер строки в Excel.

    Всё читается строками: в этих файлах в числовых по смыслу столбцах
    попадается «вакансия», и любое приведение типов тут только мешает.
    """
    if not path.exists():
        sys.exit(f"Файл не найден: {path}")
    if sheet is None:
        sheet = pick_sheet(path)
    frame = pd.read_excel(path, sheet_name=sheet, dtype=str)
    frame = frame.loc[:, [c for c in frame.columns if not str(c).startswith("Unnamed")]]

    # Номер строки в самом файле — чтобы при проверке сразу открыть нужную.
    # +2: первая строка занята заголовком, нумерация в Excel с единицы.
    frame["__строка"] = frame.index + 2

    # Совсем пустые строки в конце листа только мешают.
    data_columns = [c for c in frame.columns if c != "__строка"]
    filled = frame[data_columns].map(clean).ne("").any(axis=1)
    frame = frame[filled].copy()

    print(f"{label}: лист «{sheet}», строк {len(frame)}, столбцов {len(data_columns)}")
    return frame


def column_map(mine: pd.DataFrame, theirs: pd.DataFrame) -> tuple[dict, list, list]:
    """Сопоставляет столбцы двух файлов по заголовкам без учёта регистра.

    Возвращает: соответствие «мой заголовок → её заголовок», список общих
    столбцов в моём порядке и список столбцов, которые есть только в одном
    из файлов.
    """
    mine_by_norm = {norm_header(c): c for c in mine.columns if c != "__строка"}
    theirs_by_norm = {norm_header(c): c for c in theirs.columns if c != "__строка"}

    shared, pairs, only = [], {}, []
    for key, name in mine_by_norm.items():
        if key in theirs_by_norm:
            shared.append(name)
            pairs[name] = theirs_by_norm[key]
        else:
            only.append({"Столбец": name, "Где есть": "только у меня"})
    for key, name in theirs_by_norm.items():
        if key not in mine_by_norm:
            only.append({"Столбец": name, "Где есть": "только у неё"})
    return pairs, shared, only


def key_of(row: pd.Series, columns: list[str], frame_columns) -> tuple | None:
    """Ключ строки по набору столбцов. None, если хоть одного столбца нет."""
    values = []
    for column in columns:
        match = next((c for c in frame_columns if norm_header(c) == norm_header(column)), None)
        if match is None:
            return None
        values.append(norm_value(row[match]))
    return tuple(values)


def match_rows(mine: pd.DataFrame, theirs: pd.DataFrame) -> tuple[list, list, list]:
    """Сопоставляет строки в три прохода. Возвращает пары и остатки.

    Внутри одного ключа может быть несколько строк — например две одинаковые
    открытые вакансии. Тогда они спариваются по порядку, сколько хватит;
    лишние уходят в остаток и попадут в «Добавлено» или «Удалено».
    """
    unmatched_mine = list(mine.index)
    unmatched_theirs = list(theirs.index)
    pairs = []

    for columns, reason in MATCH_STAGES:
        # Её строки раскладываем по ключу; пустой ключ не годится — по нему
        # склеились бы все вакансии подряд.
        buckets: dict[tuple, list] = {}
        for index in unmatched_theirs:
            key = key_of(theirs.loc[index], columns, theirs.columns)
            if key is None or all(part == "" for part in key):
                continue
            buckets.setdefault(key, []).append(index)

        still_mine = []
        taken = set()
        for index in unmatched_mine:
            key = key_of(mine.loc[index], columns, mine.columns)
            bucket = buckets.get(key) if key and any(key) else None
            if not bucket:
                still_mine.append(index)
                continue
            partner = bucket.pop(0)
            taken.add(partner)
            pairs.append((index, partner, reason))

        unmatched_mine = still_mine
        unmatched_theirs = [i for i in unmatched_theirs if i not in taken]

    return pairs, unmatched_mine, unmatched_theirs


def build_changes(mine, theirs, pairs, pairs_map, shared) -> pd.DataFrame:
    """Построчный список расхождений: одна строка — один изменившийся столбец."""
    rows = []
    for mine_index, theirs_index, reason in pairs:
        mine_row, theirs_row = mine.loc[mine_index], theirs.loc[theirs_index]
        for column in shared:
            before_raw = clean(mine_row[column])
            after_raw = clean(theirs_row[pairs_map[column]])
            if norm_value(before_raw) == norm_value(after_raw):
                continue

            delta = ""
            before_number, after_number = as_number(before_raw), as_number(after_raw)
            if before_number is not None and after_number is not None:
                delta = round(after_number - before_number, 2)

            rows.append({
                "Важность": "высокая" if column in IMPORTANT else "",
                "Как сопоставлено": reason,
                "Строка у меня": mine_row["__строка"],
                "Строка у неё": theirs_row["__строка"],
                "ФИО": clean(mine_row.get(NAME_COLUMN, "")) or
                       clean(theirs_row.get(pairs_map.get(NAME_COLUMN, ""), "")),
                "Проект": clean(mine_row.get("Проект / фукнция", "")),
                "Продукт": clean(mine_row.get("Продукт (кратко)", "")),
                "Роль": clean(mine_row.get("Роль", "")),
                "Столбец": column,
                "Было (моё)": before_raw,
                "Стало (её)": after_raw,
                "Δ": delta,
                "Принято": "",
                "Комментарий проверки": "",
            })

    changes = pd.DataFrame(rows)
    if changes.empty:
        return changes
    # Сначала деньги и люди, дальше по проекту и человеку: так проверка идёт
    # по одному сотруднику за раз, а не прыгает по файлу.
    changes["_в"] = (changes["Важность"] != "высокая").astype(int)
    changes = changes.sort_values(
        ["_в", "Проект", "Продукт", "ФИО", "Столбец"]
    ).drop(columns="_в")
    return changes


def full_rows(frame: pd.DataFrame, indexes: list, columns: list) -> pd.DataFrame:
    """Целые строки для листов «Добавлено» и «Удалено» — готовые к переносу."""
    if not indexes:
        return pd.DataFrame(columns=["Строка в файле"] + columns + ["Принято"])
    block = frame.loc[indexes].copy()
    out = pd.DataFrame({"Строка в файле": block["__строка"]})
    for column in columns:
        match = next((c for c in block.columns if norm_header(c) == norm_header(column)), None)
        out[column] = block[match].map(clean) if match else ""
    out["Принято"] = ""
    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("mine", type=Path, help="моя таблица (эталон, та что идёт в дашборд)")
    parser.add_argument("theirs", type=Path, help="таблица кадровой службы")
    parser.add_argument("--out", type=Path, default=Path("сверка.xlsx"))
    parser.add_argument("--sheet-mine", default=None, help="лист в моём файле")
    parser.add_argument("--sheet-theirs", default=None, help="лист в её файле")
    args = parser.parse_args()

    mine = read_table(args.mine, args.sheet_mine, "Моя таблица")
    theirs = read_table(args.theirs, args.sheet_theirs, "Таблица кадров")

    pairs_map, shared, only_columns = column_map(mine, theirs)
    if only_columns:
        print("Столбцы есть не в обоих файлах:")
        for item in only_columns:
            print(f"  · {item['Столбец']} — {item['Где есть']}")

    pairs, only_mine, only_theirs = match_rows(mine, theirs)
    changes = build_changes(mine, theirs, pairs, pairs_map, shared)

    mine_columns = [c for c in mine.columns if c != "__строка"]
    theirs_columns = [c for c in theirs.columns if c != "__строка"]
    added = full_rows(theirs, only_theirs, theirs_columns)
    removed = full_rows(mine, only_mine, mine_columns)

    by_column = (
        changes.groupby("Столбец").size().sort_values(ascending=False)
        if not changes.empty else pd.Series(dtype=int)
    )
    summary = [
        ("Строк в моей таблице", len(mine)),
        ("Строк в таблице кадров", len(theirs)),
        ("Сопоставлено строк", len(pairs)),
        ("Расхождений в ячейках", len(changes)),
        ("из них важных (деньги, человек, роль)",
         int((changes["Важность"] == "высокая").sum()) if not changes.empty else 0),
        ("Строк только у неё (добавить)", len(added)),
        ("Строк только у меня (проверить, не удалила ли)", len(removed)),
        ("Столбцов есть не в обоих файлах", len(only_columns)),
    ]
    summary += [(f"   расхождений в «{name}»", int(count)) for name, count in by_column.items()]

    with pd.ExcelWriter(args.out, engine="openpyxl") as writer:
        pd.DataFrame(summary, columns=["Показатель", "Значение"]).to_excel(
            writer, sheet_name="Сводка", index=False
        )
        (changes if not changes.empty else pd.DataFrame(
            [{"Результат": "Расхождений в общих столбцах нет"}]
        )).to_excel(writer, sheet_name="Изменения", index=False)
        added.to_excel(writer, sheet_name="Добавлено", index=False)
        removed.to_excel(writer, sheet_name="Удалено", index=False)
        (pd.DataFrame(only_columns) if only_columns else pd.DataFrame(
            [{"Результат": "Наборы столбцов совпадают"}]
        )).to_excel(writer, sheet_name="Столбцы", index=False)

    print()
    for name, value in summary[:8]:
        print(f"{name}: {value}")
    print(f"\nЗаписано: {args.out}")


if __name__ == "__main__":
    main()
