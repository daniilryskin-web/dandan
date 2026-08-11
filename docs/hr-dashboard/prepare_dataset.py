#!/usr/bin/env python3
"""
Подготовка таблицы занятости к загрузке в Yandex DataLens.

Читает исходный Excel в том виде, в каком его ведут руками, и приводит к
датасету, в котором все метрики дашборда считаются простыми SUM/AVG — без
LOD-выражений, поведение которых зависит от разреза чарта.

Главное правило расчётов: зарплата сравнивается ТОЛЬКО с проектной ролью,
то есть с фактически выполняемой работой. Штатная должность в расчёты не
входит вообще — её могли назначить формально, чтобы обосновать оклад, и
сравнение с её медианой проверяло бы решение против его же обоснования.
В датасете должность остаётся справочной колонкой: посмотреть глазами
можно, ни на одну цифру она не влияет.

Запуск:
    python3 prepare_dataset.py                    # берёт Datalens.xlsx рядом со скриптом
    python3 prepare_dataset.py другой.xlsx        # или указанный файл

Создаёт:
    datalens_dataset.csv   — витрина назначений, её и грузим в DataLens
    datalens_dataset.xlsx  — то же самое плюс листы «Сотрудники», «Оценка ЗП»,
                             «Роли», «Проекты», «Вакансии», «Проверки»

Никаких данных внутри скрипта нет: он работает с тем файлом, который ему передали.
Описание всех листов и столбцов — в 07-dataset-reference.md.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

# Имя исходной выгрузки по умолчанию: кладём файл рядом со скриптом и
# запускаем без аргументов.
DEFAULT_SOURCE = Path("Datalens.xlsx")

# Обязательные столбцы: исходное имя → имя в датасете
SOURCE_COLUMNS = {
    "№": "Строка",
    "Ответственный за направление": "Блок",
    "Непосредственный руководитель": "Руководитель",
    "Проект / фукнция": "Проект",
    "Продукт (кратко)": "Продукт кратко",
    "Продукт": "Продукт",
    "Роль": "Проектная роль",
    "ФИО (штат)": "Сотрудник",
    "Текущая ЗП, gross": "ЗП исходная",
    "Комментарий": "Комментарий",
}

# Столбцы, которых может не быть в старых версиях файла. Оба — справочные:
# ни один из них не участвует в расчёте зарплатных метрик.
OPTIONAL_COLUMNS = {
    "Организация": "Организация",
    "Должность": "Штатная должность",
}

VACANCY_MARKER = "вакансия"
EMPTY_MARKERS = {"", "#n/a", "#н/д", "n/a", "нет данных", "-", "—"}

# Уровень ответственности по проектной роли. Порядковая шкала, нужна для двух
# вещей: сортировки ролей по старшинству на чартах и отката, когда в самой
# роли меньше MIN_GROUP_SIZE человек и медиана по ней недостоверна.
#
# Уровни назначены по смыслу роли, а НЕ по зарплате: вывести уровень из
# зарплаты нельзя, иначе мы будем сравнивать зарплату с группой, составленной
# по зарплате. Монотонность медиан по уровням — это проверка классификации,
# скрипт печатает её при каждом запуске.
ROLE_LEVELS = {
    "Стажер": (0, "R0 · Стажировка"),
    "Специалист": (1, "R1 · Исполнение"),
    "Администратор проекта": (2, "R2 · Администрирование"),
    "Аналитик": (2, "R2 · Администрирование"),
    "Исполнитель функции": (3, "R3 · Ведение продукта / функции"),
    "Руководитель продукта": (3, "R3 · Ведение продукта / функции"),
    "Руководитель проекта": (4, "R4 · Руководство проектом / функцией"),
    "Руководитель функции": (4, "R4 · Руководство проектом / функцией"),
}

# Роли с плоской тарифной ставкой: разброса нет, сравнивать не с чем.
# Исключаем из анализа справедливости, иначе они забьют «норму» и сдвинут медианы.
FLAT_RATE_ROLES = {"Стажер"}

# Комментарии, означающие «числу в столбце ЗП верить нельзя»
UNCONFIRMED_PATTERNS = [
    r"не указана",
    r"не заполнена",
    r"о[вп]ерить\s+зп",     # «проверить ЗП», «поверить ЗП»
    r"зп\s+и\s+должность",
    r"должность\s+и\s+зп",
]

MIN_GROUP_SIZE = 4          # минимум людей в роли, чтобы медиана по ней считалась
LOWER_THRESHOLD = 0.90      # ниже — «ниже роли»
UPPER_THRESHOLD = 1.30      # выше — «переплата»

# Порядок столбцов в витрине: сначала «где и кто», потом «сколько платят»,
# потом расчёты и в конце риски.
COLUMN_ORDER = [
    "Дата среза", "Строка",
    "Блок", "Проект", "Продукт кратко", "Продукт", "Продукт ключ", "Руководитель",
    "Сотрудник", "Организация", "Штатная должность",
    "Проектная роль", "Уровень роли №", "Уровень роли",
    "Вакансия", "ЗП исходная", "ЗП", "ЗП подтверждена", "Комментарий",
    "Назначений у сотрудника", "Проектов у сотрудника",
    "Мультипродуктовый", "Мультипроектный",
    "Доля занятости", "Первичное назначение", "ФОТ аллоцированный",
    "В анализе справедливости",
    "Людей в роли", "Медиана роли", "Среднее роли", "СКО роли",
    "Q1 роли", "Q3 роли", "Медиана уровня роли",
    "База сравнения", "Уровень сравнения",
    "Compa-ratio", "Отклонение руб", "Z-score",
    "Граница выброса вверх", "Граница выброса вниз", "Выброс по IQR",
    "Оценка ЗП", "Группа оценки", "Требует внимания", "Доплата до порога",
    "Оценка стоимости вакансии",
    "Людей на продукте", "Bus factor",
]


def clean_text(value) -> str:
    """Убирает переносы строк, неразрывные пробелы и двойные пробелы.

    Нормализацию делаем вручную, а не через NFKC: последняя превращает «№»
    в «No» и ломает совпадение имён столбцов.
    """
    if pd.isna(value):
        return ""
    text = str(value).replace("\xa0", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def pick_sheet(path: Path) -> str:
    """Находит лист с данными: первый, где есть все обязательные столбцы.

    В книге обычно лежат и служебные листы (сводные, справочники), причём
    вперёд они попадают чаще, чем сам реестр. Брать просто первый нельзя.
    """
    book = pd.read_excel(path, sheet_name=None, dtype=str, nrows=0)
    for name, frame in book.items():
        columns = {clean_text(c) for c in frame.columns}
        if set(SOURCE_COLUMNS).issubset(columns):
            return name
    sys.exit(
        "Ни на одном листе нет полного набора обязательных столбцов.\n"
        "Листы в файле: " + ", ".join(book) + "\n"
        "Нужны: " + ", ".join(SOURCE_COLUMNS)
    )


def load_source(path: Path, sheet: str | int | None = None) -> pd.DataFrame:
    if sheet is None:
        sheet = pick_sheet(path)
        print(f"Лист с данными: «{sheet}»")

    df = pd.read_excel(path, sheet_name=sheet, dtype=str)
    df.columns = [clean_text(c) for c in df.columns]

    missing = [c for c in SOURCE_COLUMNS if c not in df.columns]
    if missing:
        sys.exit(
            "В файле не хватает столбцов: "
            + ", ".join(missing)
            + "\nНайдены: "
            + ", ".join(df.columns)
        )

    present_optional = {k: v for k, v in OPTIONAL_COLUMNS.items() if k in df.columns}
    for name in OPTIONAL_COLUMNS:
        if name not in present_optional:
            print(f"Внимание: столбца «{name}» нет — колонка будет пустой")

    keep = list(SOURCE_COLUMNS) + list(present_optional)
    df = df[keep].rename(columns={**SOURCE_COLUMNS, **present_optional})
    for column in df.columns:
        df[column] = df[column].map(clean_text)

    for target in OPTIONAL_COLUMNS.values():
        if target not in df.columns:
            df[target] = ""
        df.loc[df[target].str.lower().isin(EMPTY_MARKERS), target] = ""
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
    df["ЗП подтверждена"] = (
        ~unconfirmed & (df["Вакансия"] == 0) & df["ЗП"].notna()
    ).astype(int)

    # Вакансия — не человек. Пустой идентификатор вместо служебной заглушки,
    # иначе все открытые позиции склеятся в одного «сотрудника». Идентификатор
    # держим строкой: числовой тип превратил бы «176» в «176.0» на подписях.
    df["Сотрудник"] = df["Сотрудник"].map(clean_text).str.replace(
        r"\.0$", "", regex=True
    )
    df.loc[df["Вакансия"] == 1, "Сотрудник"] = ""

    # --- ключи ---------------------------------------------------------------
    df["Продукт ключ"] = df["Проект"] + " / " + df["Продукт"]
    df["Руководитель"] = df["Руководитель"].str.replace(
        r"^Вакансия\s*\(?", "Вакансия: ", regex=True
    ).str.rstrip(")")

    # --- уровень ответственности по проектной роли ---------------------------
    levels = df["Проектная роль"].map(ROLE_LEVELS)
    df["Уровень роли №"] = levels.map(lambda v: v[0] if isinstance(v, tuple) else -1)
    df["Уровень роли"] = levels.map(
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

    df["Мультипродуктовый"] = (df["Назначений у сотрудника"] > 1).map(
        {True: "Да", False: "Нет"}
    )
    df["Мультипроектный"] = (df["Проектов у сотрудника"] > 1).map(
        {True: "Да", False: "Нет"}
    )

    # Первичное назначение — ровно одна строка на человека. Даёт возможность
    # считать численность и «неразмазанный» ФОТ обычным SUM в любом BI.
    df["Первичное назначение"] = 0
    first_rows = df.loc[people].drop_duplicates("Сотрудник").index
    df.loc[first_rows, "Первичное назначение"] = 1

    df["ФОТ аллоцированный"] = (df["ЗП"] * df["Доля занятости"]).round(2)

    # --- справедливость оплаты: база — ТОЛЬКО проектная роль -----------------
    df["В анализе справедливости"] = (
        (df["Вакансия"] == 0)
        & (df["Первичное назначение"] == 1)
        & df["ЗП"].notna()
        & ~df["Проектная роль"].isin(FLAT_RATE_ROLES)
        & (df["Уровень роли №"] >= 0)
    ).astype(int)

    scored = df[df["В анализе справедливости"] == 1]
    stats = scored.groupby("Проектная роль")["ЗП"].agg(
        **{
            "Медиана роли": "median",
            "Среднее роли": "mean",
            "СКО роли": "std",
            "Людей в роли": "count",
        }
    )
    stats["Q1 роли"] = scored.groupby("Проектная роль")["ЗП"].quantile(0.25)
    stats["Q3 роли"] = scored.groupby("Проектная роль")["ЗП"].quantile(0.75)

    level_median = scored.groupby("Уровень роли")["ЗП"].median()
    df = df.join(stats, on="Проектная роль")
    df["Медиана уровня роли"] = df["Уровень роли"].map(level_median)

    small = df["Людей в роли"].fillna(0) < MIN_GROUP_SIZE
    df["База сравнения"] = df["Медиана роли"].where(~small, df["Медиана уровня роли"])
    df["Уровень сравнения"] = "Проектная роль"
    df.loc[small, "Уровень сравнения"] = "Уровень роли (мало данных)"
    df.loc[df["В анализе справедливости"] == 0, "Уровень сравнения"] = "Не сравнивается"

    in_scope = df["В анализе справедливости"] == 1
    df.loc[in_scope, "Compa-ratio"] = (df["ЗП"] / df["База сравнения"]).round(3)
    df.loc[in_scope, "Отклонение руб"] = (df["ЗП"] - df["База сравнения"]).round(0)
    df.loc[in_scope, "Z-score"] = (
        (df["ЗП"] - df["Среднее роли"]) / df["СКО роли"]
    ).round(2)

    # Выброс по IQR — независимая от Compa-ratio проверка. Там, где два метода
    # сходятся, случай самый надёжный.
    #
    # Две тонкости, без которых метод врёт:
    # 1. Сравниваем по неокруглённым границам. Округление вниз делало выбросом
    #    любого, кто получает ровно медиану (71 966.24 > 71 966).
    # 2. При нулевом межквартильном размахе правило неприменимо: у роли с
    #    плоским тарифом Q1 = Q3, границы схлопываются в точку, и «выбросом»
    #    оказывается любое отличие хоть на рубль.
    iqr = df["Q3 роли"] - df["Q1 роли"]
    upper = df["Q3 роли"] + 1.5 * iqr
    lower = df["Q1 роли"] - 1.5 * iqr
    df["Граница выброса вверх"] = upper.round(0)
    df["Граница выброса вниз"] = lower.round(0)

    applicable = in_scope & (iqr > 0)
    df["Выброс по IQR"] = "—"
    df.loc[in_scope & (iqr <= 0), "Выброс по IQR"] = "Неприменимо (плоский тариф)"
    df.loc[applicable, "Выброс по IQR"] = "В норме"
    df.loc[applicable & (df["ЗП"] > upper), "Выброс по IQR"] = "Выброс вверх"
    df.loc[applicable & (df["ЗП"] < lower), "Выброс по IQR"] = "Выброс вниз"

    def rating(row):
        """Оценка зарплаты относительно медианы её проектной роли.

        Цифровой префикс нужен, чтобы легенда и оси сортировались от
        недоплаты к переплате, а не по алфавиту.
        """
        if row["В анализе справедливости"] != 1 or pd.isna(row["Compa-ratio"]):
            return "0. Не оценивается"
        compa = row["Compa-ratio"]
        if compa < 0.80:
            return "1. Недоплата"
        if compa < LOWER_THRESHOLD:
            return "2. Ниже роли"
        if compa <= 1.15:
            return "3. Соответствует роли"
        if compa <= UPPER_THRESHOLD:
            return "4. Выше роли"
        return "5. Переплата"

    df["Оценка ЗП"] = df.apply(rating, axis=1)

    # Три класса для раскраски чартов: пять цветов человек надёжно не
    # различает, поэтому цвет несёт направление, а текст — степень.
    df["Группа оценки"] = df["Оценка ЗП"].map(
        {
            "1. Недоплата": "Недоплата",
            "2. Ниже роли": "Недоплата",
            "3. Соответствует роли": "Соответствует роли",
            "4. Выше роли": "Переплата",
            "5. Переплата": "Переплата",
        }
    ).fillna("Не оценивается")

    df["Требует внимания"] = (
        in_scope
        & (
            (df["Compa-ratio"] < LOWER_THRESHOLD)
            | (df["Compa-ratio"] > UPPER_THRESHOLD)
            | (df["Z-score"].abs() > 2)
        )
    ).astype(int)

    df["Доплата до порога"] = 0.0
    below = in_scope & (df["Compa-ratio"] < LOWER_THRESHOLD)
    df.loc[below, "Доплата до порога"] = (
        df["База сравнения"] * LOWER_THRESHOLD - df["ЗП"]
    ).round(0)

    # --- оценка стоимости вакансий -------------------------------------------
    # Медиана роли — лучшая доступная оценка того, во сколько обойдётся
    # закрытие открытой позиции. Считаем по всем занятым, включая роли с
    # плоским тарифом: они вне светофора, но стоить будут столько же.
    staffed = df[(df["Вакансия"] == 0) & (df["Первичное назначение"] == 1)]
    role_median_all = staffed.groupby("Проектная роль")["ЗП"].median()
    df["Оценка стоимости вакансии"] = 0.0
    df.loc[df["Вакансия"] == 1, "Оценка стоимости вакансии"] = (
        df["Проектная роль"].map(role_median_all).round(0)
    )

    # --- риски ---------------------------------------------------------------
    # Считаем по всем строкам с людьми, а не по первичным назначениям: человек
    # может быть «первичным» на одном продукте, но работать ещё на трёх, и для
    # каждого из них он такой же участник команды.
    product_people = (
        df[df["Вакансия"] == 0].groupby("Продукт ключ")["Сотрудник"].nunique()
    )
    df["Людей на продукте"] = (
        df["Продукт ключ"].map(product_people).fillna(0).astype(int)
    )
    df["Bus factor"] = pd.cut(
        df["Людей на продукте"],
        bins=[-1, 0, 1, 2, 10_000],
        labels=["Только вакансии", "Критично: 1 человек", "Риск: 2 человека", "ОК"],
    ).astype(str)

    return df


def order_columns(df: pd.DataFrame) -> pd.DataFrame:
    present = [c for c in COLUMN_ORDER if c in df.columns]
    rest = [c for c in df.columns if c not in present]
    return df[present + rest]


# --------------------------------------------------------------------------
# Листы результата
# --------------------------------------------------------------------------

def sheet_people(df: pd.DataFrame) -> pd.DataFrame:
    """Один человек — одна строка. Реестр для разбора зарплат."""
    people = df[(df["Вакансия"] == 0) & (df["Первичное назначение"] == 1)]
    columns = [
        "Сотрудник", "Проектная роль", "Уровень роли", "ЗП", "ЗП подтверждена",
        "База сравнения", "Уровень сравнения", "Compa-ratio", "Отклонение руб",
        "Z-score", "Выброс по IQR", "Оценка ЗП", "Требует внимания",
        "Доплата до порога", "Организация", "Штатная должность",
        "Блок", "Проект", "Руководитель",
        "Назначений у сотрудника", "Проектов у сотрудника",
    ]
    return people[columns].sort_values("Отклонение руб")


def sheet_roles(df: pd.DataFrame) -> pd.DataFrame:
    """База сравнения в явном виде: сколько платят за каждую роль."""
    scored = df[df["В анализе справедливости"] == 1]
    table = (
        scored.groupby(["Уровень роли №", "Уровень роли", "Проектная роль"])["ЗП"]
        .agg(
            людей="count", минимум="min", Q1=lambda s: s.quantile(0.25),
            медиана="median", Q3=lambda s: s.quantile(0.75), максимум="max",
            среднее="mean", СКО="std",
        )
        .round(0)
    )
    table["разброс, раз"] = (table["максимум"] / table["минимум"]).round(1)
    table["используется как база"] = (table["людей"] >= MIN_GROUP_SIZE).map(
        {True: "да", False: "нет, откат на уровень"}
    )
    return table


def sheet_rating(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Три среза оценки зарплат: по категориям, по ролям, по проектам."""
    scored = df[df["В анализе справедливости"] == 1]
    total = len(scored)

    by_rating = scored.groupby("Оценка ЗП").agg(
        людей=("Сотрудник", "count"),
        медиана_ЗП=("ЗП", "median"),
        медиана_базы=("База сравнения", "median"),
        сумма_отклонения=("Отклонение руб", "sum"),
        доплата_до_порога=("Доплата до порога", "sum"),
        подтверждённых_ЗП=("ЗП подтверждена", "sum"),
    )
    by_rating["доля, %"] = (by_rating["людей"] / total * 100).round(1)
    by_rating["сумма_отклонения_год"] = by_rating["сумма_отклонения"] * 12
    by_rating = by_rating[[
        "людей", "доля, %", "подтверждённых_ЗП", "медиана_ЗП", "медиана_базы",
        "сумма_отклонения", "сумма_отклонения_год", "доплата_до_порога",
    ]].round(0)

    by_role = pd.crosstab(
        [scored["Уровень роли №"], scored["Проектная роль"]],
        scored["Оценка ЗП"],
        margins=True,
        margins_name="Всего",
    )

    by_project = pd.crosstab(
        [scored["Блок"], scored["Проект"]],
        scored["Группа оценки"],
        margins=True,
        margins_name="Всего",
    )

    return by_rating, by_role, by_project


def sheet_projects(df: pd.DataFrame) -> pd.DataFrame:
    """Сводка по проектам: во что обходится каждое направление."""
    people = df[df["Вакансия"] == 0]
    table = people.groupby(["Блок", "Проект"]).agg(
        сотрудников=("Сотрудник", "nunique"),
        FTE=("Доля занятости", "sum"),
        продуктов=("Продукт ключ", "nunique"),
        ФОТ_мес=("ФОТ аллоцированный", "sum"),
    )
    table["стоимость FTE"] = table["ФОТ_мес"] / table["FTE"]
    vacancies = df[df["Вакансия"] == 1].groupby("Проект").size()
    table["вакансий"] = table.index.get_level_values("Проект").map(vacancies).fillna(0)
    table["доля ФОТ, %"] = (table["ФОТ_мес"] / table["ФОТ_мес"].sum() * 100).round(1)
    return table.round(1).sort_values("ФОТ_мес", ascending=False)


def sheet_vacancies(df: pd.DataFrame) -> pd.DataFrame:
    """Открытые позиции и во что обойдётся их закрытие."""
    vacancies = df[df["Вакансия"] == 1]
    columns = [
        "Строка", "Блок", "Проект", "Продукт", "Проектная роль", "Уровень роли",
        "Оценка стоимости вакансии", "Руководитель",
    ]
    return vacancies[columns].sort_values(
        "Оценка стоимости вакансии", ascending=False
    )


def sheet_checks(df: pd.DataFrame) -> pd.DataFrame:
    """Контроль качества данных. Всё, кроме первых строк, должно быть нулём."""
    people = df[df["Вакансия"] == 0]
    unique_people = people[people["Первичное назначение"] == 1]

    salary_conflicts = people.groupby("Сотрудник")["ЗП"].nunique()
    role_conflicts = people.groupby("Сотрудник")["Проектная роль"].nunique()
    org_conflicts = people[people["Организация"] != ""].groupby("Сотрудник")[
        "Организация"
    ].nunique()
    owners = df.groupby("Проект")["Блок"].nunique()
    duplicates = df.groupby(["Сотрудник", "Продукт ключ", "Проектная роль"]).size()
    duplicates = duplicates[duplicates.index.get_level_values(0) != ""]

    checks = [
        ("Строк всего", len(df), "справочно"),
        ("Открытых вакансий", int(df["Вакансия"].sum()), "справочно"),
        ("Уникальных сотрудников", len(unique_people), "справочно"),
        ("Проектов", df["Проект"].nunique(), "справочно"),
        ("Продуктов", df["Продукт ключ"].nunique(), "справочно"),
        ("Проектных ролей", df["Проектная роль"].nunique(), "справочно"),
        ("В анализе справедливости", int(df["В анализе справедливости"].sum()),
         "справочно: без вакансий и ролей с плоским тарифом"),
        ("ЗП не подтверждена (людей)",
         int((unique_people["ЗП подтверждена"] == 0).sum()),
         "комментарий говорит, что числу верить нельзя"),
        ("ЗП пустая (строк)", int(people["ЗП"].isna().sum()), "должно быть 0"),
        ("Разные ЗП у одного сотрудника", int((salary_conflicts > 1).sum()),
         "должно быть 0: зарплата — атрибут человека"),
        ("Разные роли у одного сотрудника", int((role_conflicts > 1).sum()),
         "допустимо, если человек играет разные роли в разных продуктах"),
        ("Разные организации у одного сотрудника", int((org_conflicts > 1).sum()),
         "должно быть 0"),
        ("Проектов с несколькими блоками", int((owners > 1).sum()), "должно быть 0"),
        ("Дублей назначений", int((duplicates > 1).sum()), "должно быть 0"),
        ("Ролей вне классификатора", int((people["Уровень роли №"] == -1).sum()),
         "дополнить ROLE_LEVELS в скрипте"),
        ("Ролей без достаточной выборки",
         int((df[df["В анализе справедливости"] == 1]["Уровень сравнения"]
              != "Проектная роль").sum()),
         f"людей, сравниваемых по откату (в роли меньше {MIN_GROUP_SIZE} человек)"),
        ("Продуктов с одним человеком",
         int(df[df["Bus factor"] == "Критично: 1 человек"]["Продукт ключ"].nunique()),
         "риск незаменимости"),
    ]
    return pd.DataFrame(checks, columns=["Проверка", "Значение", "Комментарий"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, nargs="?", default=DEFAULT_SOURCE,
        help=f"исходный .xlsx (по умолчанию {DEFAULT_SOURCE})",
    )
    parser.add_argument("--out", type=Path, default=Path("datalens_dataset"))
    parser.add_argument(
        "--sheet", default=None,
        help="имя или номер листа; по умолчанию определяется автоматически",
    )
    parser.add_argument(
        "--snapshot", default="",
        help="дата среза в формате ГГГГ-ММ-ДД; заполняет столбец «Дата среза»",
    )
    args = parser.parse_args()

    if not args.source.exists():
        sys.exit(
            f"Файл не найден: {args.source}\n"
            f"Положите исходную выгрузку рядом со скриптом под именем {DEFAULT_SOURCE} "
            "или укажите путь первым аргументом."
        )

    sheet = int(args.sheet) if str(args.sheet).isdigit() else args.sheet
    print(f"Читаю: {args.source}")
    raw = load_source(args.source, sheet)

    assignments = build_assignments(raw)
    if args.snapshot:
        assignments["Дата среза"] = args.snapshot
    assignments = order_columns(assignments)

    csv_path = args.out.with_suffix(".csv")
    assignments.to_csv(csv_path, index=False, encoding="utf-8-sig")

    roles = sheet_roles(assignments)
    by_rating, by_role, by_project = sheet_rating(assignments)

    xlsx_path = args.out.with_suffix(".xlsx")
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        assignments.to_excel(writer, sheet_name="Назначения", index=False)
        sheet_people(assignments).to_excel(writer, sheet_name="Сотрудники", index=False)

        # Три таблицы на одном листе, разделённые пустыми строками
        sheet = "Оценка ЗП"
        row = 0
        for title, table in (
            ("Сводка по категориям оценки", by_rating),
            ("Разбивка по проектным ролям", by_role),
            ("Разбивка по проектам", by_project),
        ):
            pd.DataFrame({title: []}).to_excel(writer, sheet_name=sheet, startrow=row)
            table.to_excel(writer, sheet_name=sheet, startrow=row + 1)
            row += len(table) + 4

        roles.to_excel(writer, sheet_name="Роли")
        sheet_projects(assignments).to_excel(writer, sheet_name="Проекты")
        sheet_vacancies(assignments).to_excel(writer, sheet_name="Вакансии", index=False)
        sheet_checks(assignments).to_excel(writer, sheet_name="Проверки", index=False)

    print(f"Записано: {csv_path}  ({len(assignments)} строк)")
    print(f"Записано: {xlsx_path}")
    print()
    print(sheet_checks(assignments).to_string(index=False))

    # Проверка классификации ролей: медианы по уровням обязаны расти монотонно.
    # Если нет — уровень назначен неверно, и откат на него будет искажать базу.
    medians = roles.groupby(level=0)["медиана"].median().tolist()
    monotone = all(a <= b for a, b in zip(medians, medians[1:]))
    print()
    print(
        "Медианы по уровням ролей:",
        " → ".join(f"{m:,.0f}".replace(",", " ") for m in medians),
    )
    print("Монотонность:", "ОК" if monotone else "НАРУШЕНА — проверьте ROLE_LEVELS")

    print()
    print("Оценка зарплат (относительно медианы проектной роли):")
    print(by_rating[["людей", "доля, %", "подтверждённых_ЗП", "сумма_отклонения"]].to_string())


if __name__ == "__main__":
    main()
