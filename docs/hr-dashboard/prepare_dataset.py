#!/usr/bin/env python3
"""
Подготовка таблицы занятости к загрузке в Yandex DataLens.

Читает исходный Excel в том виде, в каком его ведут руками, и приводит к датасету,
в котором все метрики дашборда считаются простыми SUM/AVG — без LOD-выражений,
поведение которых зависит от разреза чарта.

Запуск:
    python3 prepare_dataset.py вход.xlsx --out datalens_dataset

Создаёт:
    datalens_dataset.csv   — витрина назначений (основная таблица для DataLens)
    datalens_dataset.xlsx  — то же самое + листы «Сотрудники», «Роли», «Проверки»

Никаких данных внутри скрипта нет: он работает с тем файлом, который ему передали.
"""

from __future__ import annotations

import argparse
import re
import sys

from pathlib import Path

import pandas as pd

# Как называются столбцы в исходнике → как они называются дальше
SOURCE_COLUMNS = {
    "№": "Строка",
    "Ответственный за направление": "Блок",
    "Непосредственный руководитель": "Руководитель",
    "Проект / фукнция": "Проект",
    "Продукт (кратко)": "Продукт кратко",
    "Продукт": "Продукт",
    "Роль": "Должность",
    "ФИО (штат)": "Сотрудник",
    "Текущая ЗП, gross": "ЗП исходная",
    "Комментарий": "Комментарий",
}

VACANCY_MARKER = "вакансия"

# Иерархия должностей: единственная порядковая шкала, которую можно вывести
# из имеющихся данных. Заменяет отсутствующий грейд при сравнении зарплат.
POSITION_LEVELS = {
    "Руководитель функции": (4, "L4 · Руководство функцией"),
    "Руководитель проекта": (4, "L4 · Руководство функцией"),
    "Руководитель продукта": (3, "L3 · Руководство продуктом"),
    "Исполнитель функции": (3, "L3 · Руководство продуктом"),
    "Администратор проекта": (2, "L2 · Исполнение"),
    "Аналитик": (2, "L2 · Исполнение"),
    "Специалист": (1, "L1 · Начальный"),
    "Стажер": (0, "L0 · Стажировка"),
}

# Должности с плоской тарифной ставкой: разброса нет, сравнивать не с чем.
# Их исключаем из анализа справедливости, иначе они забьют «норму» и сдвинут медианы.
FLAT_RATE_POSITIONS = {"Стажер"}

# Комментарии, означающие «числу в столбце ЗП верить нельзя»
UNCONFIRMED_PATTERNS = [
    r"не указана",
    r"не заполнена",
    r"о[вп]ерить\s+зп",     # «проверить ЗП», «поверить ЗП»
    r"зп\s+и\s+должность",
    r"должность\s+и\s+зп",
]

MIN_GROUP_SIZE = 4          # минимум людей в группе сравнения
LOWER_THRESHOLD = 0.90      # ниже — «недоплата»
UPPER_THRESHOLD = 1.30      # выше — «переплата»


def clean_text(value) -> str:
    """Убирает переносы строк, неразрывные пробелы и двойные пробелы.

    Namespace-нормализацию делаем вручную, а не через NFKC: последняя
    превращает «№» в «No» и ломает совпадение имён столбцов.
    """
    if pd.isna(value):
        return ""
    text = str(value).replace("\xa0", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def load_source(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path, dtype=str)
    df.columns = [clean_text(c) for c in df.columns]

    missing = [c for c in SOURCE_COLUMNS if c not in df.columns]
    if missing:
        sys.exit(
            "В файле не хватает столбцов: "
            + ", ".join(missing)
            + "\nНайдены: "
            + ", ".join(df.columns)
        )

    df = df[list(SOURCE_COLUMNS)].rename(columns=SOURCE_COLUMNS)
    for column in df.columns:
        df[column] = df[column].map(clean_text)
    return df


def build_assignments(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # --- вакансии и зарплата -------------------------------------------------
    df["Вакансия"] = (
        df["ЗП исходная"].str.lower().str.contains(VACANCY_MARKER, na=False).astype(int)
    )
    df["ЗП"] = pd.to_numeric(
        df["ЗП исходная"].str.replace(",", ".", regex=False).where(df["Вакансия"] == 0),
        errors="coerce",
    )

    unconfirmed = df["Комментарий"].str.lower().str.contains(
        "|".join(UNCONFIRMED_PATTERNS), regex=True, na=False
    )
    df["ЗП подтверждена"] = (~unconfirmed & (df["Вакансия"] == 0) & df["ЗП"].notna()).astype(int)

    # Вакансия — не человек. Пустой идентификатор вместо служебной заглушки,
    # иначе все открытые позиции склеятся в одного «сотрудника».
    df.loc[df["Вакансия"] == 1, "Сотрудник"] = ""

    # --- ключи ---------------------------------------------------------------
    df["Продукт ключ"] = df["Проект"] + " / " + df["Продукт"]
    df["Руководитель"] = df["Руководитель"].str.replace(
        r"^Вакансия\s*\(?", "Вакансия: ", regex=True
    ).str.rstrip(")")

    # --- уровень должности ---------------------------------------------------
    levels = df["Должность"].map(POSITION_LEVELS)
    df["Уровень"] = levels.map(lambda v: v[0] if isinstance(v, tuple) else -1)
    df["Уровень должности"] = levels.map(
        lambda v: v[1] if isinstance(v, tuple) else "Не классифицировано"
    )

    # --- доля занятости: поровну между продуктами сотрудника -----------------
    people = df["Вакансия"] == 0
    counts = df.loc[people].groupby("Сотрудник")["Продукт ключ"].transform("size")
    df.loc[people, "Назначений у сотрудника"] = counts
    df.loc[~people, "Назначений у сотрудника"] = 1
    df["Доля занятости"] = (1 / df["Назначений у сотрудника"]).round(4)

    projects = df.loc[people].groupby("Сотрудник")["Проект"].transform("nunique")
    df.loc[people, "Проектов у сотрудника"] = projects
    df.loc[~people, "Проектов у сотрудника"] = 1

    df["Мультипродуктовый"] = (df["Назначений у сотрудника"] > 1).map({True: "Да", False: "Нет"})
    df["Мультипроектный"] = (df["Проектов у сотрудника"] > 1).map({True: "Да", False: "Нет"})

    # Первичное назначение — ровно одна строка на человека. Даёт возможность
    # считать численность и «неразмазанный» ФОТ обычным SUM в любом BI.
    df["Первичное назначение"] = 0
    first_rows = df.loc[people].drop_duplicates("Сотрудник").index
    df.loc[first_rows, "Первичное назначение"] = 1

    df["ФОТ аллоцированный"] = (df["ЗП"] * df["Доля занятости"]).round(2)

    # --- справедливость оплаты ----------------------------------------------
    df["В анализе справедливости"] = (
        (df["Вакансия"] == 0)
        & (df["Первичное назначение"] == 1)
        & df["ЗП"].notna()
        & ~df["Должность"].isin(FLAT_RATE_POSITIONS)
    ).astype(int)

    base = df[df["В анализе справедливости"] == 1]
    stats = base.groupby("Должность")["ЗП"].agg(
        **{
            "Медиана должности": "median",
            "Среднее должности": "mean",
            "СКО должности": "std",
            "Людей в должности": "count",
        }
    )
    stats["Q1 должности"] = base.groupby("Должность")["ЗП"].quantile(0.25)
    stats["Q3 должности"] = base.groupby("Должность")["ЗП"].quantile(0.75)

    # Группа меньше порога — статистики нет, откатываемся на уровень должности
    level_median = base.groupby("Уровень должности")["ЗП"].median()
    df = df.join(stats, on="Должность")
    df["Медиана уровня"] = df["Уровень должности"].map(level_median)

    small = df["Людей в должности"].fillna(0) < MIN_GROUP_SIZE
    df["База сравнения"] = df["Медиана должности"].where(~small, df["Медиана уровня"])
    df["Уровень сравнения"] = "Должность"
    df.loc[small, "Уровень сравнения"] = "Уровень должности (мало данных)"
    df.loc[df["В анализе справедливости"] == 0, "Уровень сравнения"] = "Не сравнивается"

    in_scope = df["В анализе справедливости"] == 1
    df.loc[in_scope, "Compa-ratio"] = (df["ЗП"] / df["База сравнения"]).round(3)
    df.loc[in_scope, "Отклонение руб"] = (df["ЗП"] - df["База сравнения"]).round(0)
    df.loc[in_scope, "Z-score"] = (
        (df["ЗП"] - df["Среднее должности"]) / df["СКО должности"]
    ).round(2)

    iqr = df["Q3 должности"] - df["Q1 должности"]
    df["Граница выброса вверх"] = df["Q3 должности"] + 1.5 * iqr
    df["Граница выброса вниз"] = df["Q1 должности"] - 1.5 * iqr

    def flag(row):
        if row["В анализе справедливости"] != 1:
            return "0. Не сравнивается"
        compa = row["Compa-ratio"]
        if pd.isna(compa):
            return "0. Не сравнивается"
        if compa < 0.80:
            return "1. Недоплата"
        if compa < LOWER_THRESHOLD:
            return "2. Ниже группы"
        if compa <= 1.15:
            return "3. Норма"
        if compa <= UPPER_THRESHOLD:
            return "4. Выше группы"
        return "5. Переплата"

    df["Флаг ЗП"] = df.apply(flag, axis=1)
    df["Цвет флага"] = df["Флаг ЗП"].map(
        {
            "1. Недоплата": "Недоплата",
            "2. Ниже группы": "Недоплата",
            "3. Норма": "Норма",
            "4. Выше группы": "Переплата",
            "5. Переплата": "Переплата",
        }
    ).fillna("Не сравнивается")

    df["Требует внимания"] = (
        (df["В анализе справедливости"] == 1)
        & (
            (df["Compa-ratio"] < LOWER_THRESHOLD)
            | (df["Compa-ratio"] > UPPER_THRESHOLD)
            | (df["Z-score"].abs() > 2)
        )
    ).astype(int)

    # Сколько не хватает конкретному человеку до нижнего порога
    df["Доплата до порога"] = 0.0
    below = (df["В анализе справедливости"] == 1) & (df["Compa-ratio"] < LOWER_THRESHOLD)
    df.loc[below, "Доплата до порога"] = (
        df["База сравнения"] * LOWER_THRESHOLD - df["ЗП"]
    ).round(0)

    # --- риски ---------------------------------------------------------------
    product_people = (
        df[df["Вакансия"] == 0].groupby("Продукт ключ")["Сотрудник"].nunique()
    )
    df["Людей на продукте"] = df["Продукт ключ"].map(product_people).fillna(0).astype(int)
    df["Bus factor"] = pd.cut(
        df["Людей на продукте"],
        bins=[-1, 0, 1, 2, 10_000],
        labels=["Только вакансии", "Критично: 1 человек", "Риск: 2 человека", "ОК"],
    ).astype(str)

    return df


def build_checks(df: pd.DataFrame) -> pd.DataFrame:
    people = df[df["Вакансия"] == 0]
    unique_people = people[people["Первичное назначение"] == 1]

    salary_conflicts = people.groupby("Сотрудник")["ЗП"].nunique()
    role_conflicts = people.groupby("Сотрудник")["Должность"].nunique()
    owners = df.groupby("Проект")["Блок"].nunique()
    duplicates = df.groupby(["Сотрудник", "Продукт ключ", "Должность"]).size()
    duplicates = duplicates[duplicates.index.get_level_values(0) != ""]

    checks = [
        ("Строк всего", len(df), ""),
        ("Открытых вакансий", int(df["Вакансия"].sum()), "считаются отдельно от людей"),
        ("Уникальных сотрудников", int(unique_people.shape[0]), ""),
        ("Проектов", df["Проект"].nunique(), ""),
        ("Продуктов", df["Продукт ключ"].nunique(), ""),
        ("Должностей", df["Должность"].nunique(), ""),
        (
            "ЗП не подтверждена (людей)",
            int((unique_people["ЗП подтверждена"] == 0).sum()),
            "комментарий говорит, что числу верить нельзя",
        ),
        ("ЗП пустая (строк)", int(people["ЗП"].isna().sum()), "должно быть 0"),
        (
            "Разные ЗП у одного сотрудника",
            int((salary_conflicts > 1).sum()),
            "должно быть 0",
        ),
        (
            "Разные должности у одного сотрудника",
            int((role_conflicts > 1).sum()),
            "проверить, это совмещение или ошибка",
        ),
        ("Проектов с несколькими блоками", int((owners > 1).sum()), "должно быть 0"),
        ("Дублей назначений", int((duplicates > 1).sum()), "должно быть 0"),
        (
            "Должностей вне классификатора",
            int((df["Уровень"] == -1).sum()),
            "дополнить POSITION_LEVELS в скрипте",
        ),
        (
            "Продуктов с одним человеком",
            int(df[df["Bus factor"] == "Критично: 1 человек"]["Продукт ключ"].nunique()),
            "риск незаменимости",
        ),
    ]
    return pd.DataFrame(checks, columns=["Проверка", "Значение", "Комментарий"])


def build_people_sheet(df: pd.DataFrame) -> pd.DataFrame:
    people = df[(df["Вакансия"] == 0) & (df["Первичное назначение"] == 1)]
    columns = [
        "Сотрудник", "Должность", "Уровень должности", "Блок", "Проект",
        "Руководитель", "ЗП", "ЗП подтверждена", "База сравнения",
        "Уровень сравнения", "Compa-ratio", "Отклонение руб", "Z-score",
        "Флаг ЗП", "Требует внимания", "Доплата до порога",
        "Назначений у сотрудника", "Проектов у сотрудника",
    ]
    return people[columns].sort_values("Отклонение руб")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="исходный .xlsx")
    parser.add_argument("--out", type=Path, default=Path("datalens_dataset"))
    parser.add_argument(
        "--snapshot",
        default="",
        help="дата среза в формате ГГГГ-ММ-ДД; заполняет столбец «Дата среза»",
    )
    args = parser.parse_args()

    raw = load_source(args.source)
    assignments = build_assignments(raw)
    if args.snapshot:
        assignments.insert(0, "Дата среза", args.snapshot)

    csv_path = args.out.with_suffix(".csv")
    assignments.to_csv(csv_path, index=False, encoding="utf-8-sig")

    xlsx_path = args.out.with_suffix(".xlsx")
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        assignments.to_excel(writer, sheet_name="Назначения", index=False)
        build_people_sheet(assignments).to_excel(writer, sheet_name="Сотрудники", index=False)
        (
            assignments[assignments["В анализе справедливости"] == 1]
            .groupby(["Уровень должности", "Должность"])["ЗП"]
            .agg(["count", "min", "median", "mean", "max", "std"])
            .round(0)
            .to_excel(writer, sheet_name="Должности")
        )
        build_checks(assignments).to_excel(writer, sheet_name="Проверки", index=False)

    checks = build_checks(assignments)
    print(f"Записано: {csv_path}  ({len(assignments)} строк)")
    print(f"Записано: {xlsx_path}")
    print()
    print(checks.to_string(index=False))


if __name__ == "__main__":
    main()
