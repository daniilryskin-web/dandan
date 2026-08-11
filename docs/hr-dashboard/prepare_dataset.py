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

# Столбцы, которых может не быть в старых версиях файла
OPTIONAL_COLUMNS = {
    "Организация": "Организация",
    "Должность": "Штатная должность",
}

VACANCY_MARKER = "вакансия"
EMPTY_MARKERS = {"", "#n/a", "#н/д", "n/a", "нет данных", "-", "—"}

# Грейд по штатной должности. Правила проверяются сверху вниз, первое
# сработавшее выигрывает — поэтому специфичные формулировки идут раньше общих
# («главный специалист-эксперт» должен пойматься до «специалист»).
#
# Уровни назначены по смыслу названия должности, а НЕ по зарплате: вывести
# грейд из зарплаты нельзя, иначе мы будем сравнивать зарплату с группой,
# составленной по зарплате. Монотонность медиан по грейдам — это проверка
# классификации, и она печатается в листе «Грейды».
GRADE_RULES = [
    (0, "G0 · Стажировка", ["стажер", "стажёр"]),
    (6, "G6 · Топ-менеджмент", [
        "начальник центра",
        "руководитель центра компетенций",
        "заместитель руководителя мвпо",
    ]),
    (5, "G5 · Руководство проектом / направлением", [
        "заместитель руководителя центра",
        "заместитель начальника управления",
        "директор проект",
        "руководитель проект",
        "руководитель направлен",
    ]),
    (4, "G4 · Руководство отделом / продуктом", [
        "директор по продукту",
        "руководитель продукт",
        "начальник отдела",
    ]),
    (3, "G3 · Ведущий / заместитель", [
        "ведущий эксперт",
        "главный эксперт",
        "заместитель начальника отдела",
        "руководитель группы",
        "аналитик",
    ]),
    (2, "G2 · Исполнение", [
        "главный специалист",
        "администратор проект",
        "координатор проект",
        "эксперт",
    ]),
    (1, "G1 · Специалист", ["специалист"]),
]

# Запасная шкала: применяется, когда столбца «Должность» в файле нет и грейд
# приходится выводить из проектной роли.
ROLE_FALLBACK_GRADES = {
    "Руководитель функции": (5, "G5 · Руководство проектом / направлением"),
    "Руководитель проекта": (5, "G5 · Руководство проектом / направлением"),
    "Руководитель продукта": (4, "G4 · Руководство отделом / продуктом"),
    "Исполнитель функции": (3, "G3 · Ведущий / заместитель"),
    "Аналитик": (3, "G3 · Ведущий / заместитель"),
    "Администратор проекта": (2, "G2 · Исполнение"),
    "Специалист": (1, "G1 · Специалист"),
    "Стажер": (0, "G0 · Стажировка"),
}

# Уровень фактической ответственности по проектной роли. Это порядковая шкала
# для отката, когда в самой роли слишком мало людей для медианы.
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


def load_source(path: Path, sheet: str | int = 0) -> pd.DataFrame:
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
            print(f"Внимание: столбца «{name}» нет — соответствующие разрезы будут пустыми")

    keep = list(SOURCE_COLUMNS) + list(present_optional)
    df = df[keep].rename(columns={**SOURCE_COLUMNS, **present_optional})
    for column in df.columns:
        df[column] = df[column].map(clean_text)

    for target in OPTIONAL_COLUMNS.values():
        if target not in df.columns:
            df[target] = ""
        df.loc[df[target].str.lower().isin(EMPTY_MARKERS), target] = ""
    return df


def classify_grade(position: str, role: str) -> tuple[int, str]:
    """Грейд по штатной должности; при её отсутствии — по проектной роли."""
    text = position.lower()
    if text:
        for level, label, keywords in GRADE_RULES:
            if any(keyword in text for keyword in keywords):
                return level, label
    fallback = ROLE_FALLBACK_GRADES.get(role)
    if fallback:
        return fallback
    return -1, "Не классифицировано"


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
    # иначе все открытые позиции склеятся в одного «сотрудника». Идентификатор
    # держим строкой: числовой тип превратил бы «176» в «176.0» на всех подписях.
    df["Сотрудник"] = df["Сотрудник"].map(clean_text).str.replace(
        r"\.0$", "", regex=True
    )
    df.loc[df["Вакансия"] == 1, "Сотрудник"] = ""

    # --- ключи ---------------------------------------------------------------
    df["Продукт ключ"] = df["Проект"] + " / " + df["Продукт"]
    df["Руководитель"] = df["Руководитель"].str.replace(
        r"^Вакансия\s*\(?", "Вакансия: ", regex=True
    ).str.rstrip(")")

    # --- грейд по штатной должности ------------------------------------------
    grades = df.apply(
        lambda r: classify_grade(r["Штатная должность"], r["Проектная роль"]), axis=1
    )
    df["Грейд №"] = grades.map(lambda v: v[0])
    df["Грейд"] = grades.map(lambda v: v[1])
    # У вакансий штатной должности нет — грейд выводится из проектной роли.
    # В анализ справедливости они не попадают, но это позволяет оценить,
    # во сколько обойдётся закрытие набора.

    # --- уровень фактической ответственности ---------------------------------
    levels = df["Проектная роль"].map(ROLE_LEVELS)
    df["Уровень роли №"] = levels.map(lambda v: v[0] if isinstance(v, tuple) else -1)
    df["Уровень роли"] = levels.map(
        lambda v: v[1] if isinstance(v, tuple) else "Не классифицировано"
    )

    # База сравнения — ПРОЕКТНАЯ РОЛЬ, то есть фактически выполняемая работа.
    # Штатная должность в базу не входит: её могли назначить формально, чтобы
    # обосновать зарплату, и тогда сравнение с медианой должности превратится
    # в проверку самого себя. Грейд остаётся диагностическим признаком —
    # именно расхождение «должность выше роли» и есть искомая переплата.
    df["Группа сравнения"] = df["Проектная роль"]

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
        & ~df["Проектная роль"].isin(FLAT_RATE_ROLES)
        & (df["Уровень роли №"] >= 0)
    ).astype(int)

    base = df[df["В анализе справедливости"] == 1]
    stats = base.groupby("Группа сравнения")["ЗП"].agg(
        **{
            "Медиана группы": "median",
            "Среднее группы": "mean",
            "СКО группы": "std",
            "Людей в группе": "count",
        }
    )
    stats["Q1 группы"] = base.groupby("Группа сравнения")["ЗП"].quantile(0.25)
    stats["Q3 группы"] = base.groupby("Группа сравнения")["ЗП"].quantile(0.75)

    # Группа меньше порога — статистики нет, откатываемся на уровень роли
    role_level_median = base.groupby("Уровень роли")["ЗП"].median()
    grade_median = base.groupby("Грейд")["ЗП"].median()
    df = df.join(stats, on="Группа сравнения")
    df["Медиана уровня роли"] = df["Уровень роли"].map(role_level_median)
    df["Медиана грейда"] = df["Грейд"].map(grade_median)

    small = df["Людей в группе"].fillna(0) < MIN_GROUP_SIZE
    df["База сравнения"] = df["Медиана группы"].where(~small, df["Медиана уровня роли"])
    df["Уровень сравнения"] = "Проектная роль"
    df.loc[small, "Уровень сравнения"] = "Уровень роли (мало данных)"
    df.loc[df["В анализе справедливости"] == 0, "Уровень сравнения"] = "Не сравнивается"

    in_scope = df["В анализе справедливости"] == 1
    df.loc[in_scope, "Compa-ratio"] = (df["ЗП"] / df["База сравнения"]).round(3)
    df.loc[in_scope, "Отклонение руб"] = (df["ЗП"] - df["База сравнения"]).round(0)
    df.loc[in_scope, "Z-score"] = (
        (df["ЗП"] - df["Среднее группы"]) / df["СКО группы"]
    ).round(2)

    # Справочная метрика: как зарплата соотносится со штатной должностью.
    # В базу сравнения не входит — нужна, чтобы объяснить отклонение по роли.
    df.loc[in_scope, "Compa-ratio к должности"] = (
        df["ЗП"] / df["Медиана грейда"]
    ).round(3)
    df["Разрыв должность − роль, руб"] = (
        df["Медиана грейда"] - df["База сравнения"]
    ).round(0)

    iqr = df["Q3 группы"] - df["Q1 группы"]
    df["Граница выброса вверх"] = df["Q3 группы"] + 1.5 * iqr
    df["Граница выброса вниз"] = df["Q1 группы"] - 1.5 * iqr

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

    def deviation_type(row):
        """Раскладывает отклонение на причину: роль, должность или оба.

        Ключевой случай — «Оплата по должности, а не по роли»: зарплата выше
        медианы фактической роли, но соответствует штатной должности. Значит
        должность назначена, чтобы обосновать оклад, а объём работы меньше.
        """
        if row["В анализе справедливости"] != 1:
            return "0. Не сравнивается"
        by_role = row["Compa-ratio"]
        by_grade = row["Compa-ratio к должности"]
        if pd.isna(by_role):
            return "0. Не сравнивается"
        if LOWER_THRESHOLD <= by_role <= 1.15:
            return "1. Норма"
        if by_role > 1.15:
            if pd.notna(by_grade) and by_grade <= 1.15:
                return "2. Оплата по должности, а не по роли"
            return "3. Выше и роли, и должности"
        if pd.notna(by_grade) and by_grade >= LOWER_THRESHOLD:
            return "4. Роль выше должности"
        return "5. Недоплата за роль"

    df["Тип отклонения"] = df.apply(deviation_type, axis=1)
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

    # --- оценка стоимости вакансий -------------------------------------------
    # Медиана группы сравнения — лучшая доступная оценка того, во сколько
    # обойдётся закрытие открытой позиции.
    # Медианы считаем по всем занятым позициям, включая грейды с плоским
    # тарифом: они исключены из светофора, но стоить вакансия по ним всё равно
    # будет столько же.
    staffed = df[(df["Вакансия"] == 0) & (df["Первичное назначение"] == 1)]
    role_median_all = staffed.groupby("Проектная роль")["ЗП"].median()
    vacancy_base = df["Медиана группы"].where(
        df["Людей в группе"].fillna(0) >= MIN_GROUP_SIZE,
        df["Проектная роль"].map(role_median_all),
    )
    df["Оценка стоимости вакансии"] = 0.0
    df.loc[df["Вакансия"] == 1, "Оценка стоимости вакансии"] = vacancy_base.round(0)

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
    role_conflicts = people.groupby("Сотрудник")["Штатная должность"].nunique()
    org_conflicts = people.groupby("Сотрудник")["Организация"].nunique()
    owners = df.groupby("Проект")["Блок"].nunique()
    duplicates = df.groupby(["Сотрудник", "Продукт ключ", "Проектная роль"]).size()
    duplicates = duplicates[duplicates.index.get_level_values(0) != ""]

    checks = [
        ("Строк всего", len(df), ""),
        ("Открытых вакансий", int(df["Вакансия"].sum()), "считаются отдельно от людей"),
        ("Уникальных сотрудников", int(unique_people.shape[0]), ""),
        ("Проектов", df["Проект"].nunique(), ""),
        ("Продуктов", df["Продукт ключ"].nunique(), ""),
        ("Проектных ролей", df["Проектная роль"].nunique(), ""),
        ("Штатных должностей", people["Штатная должность"].nunique(), ""),
        ("Организаций", people["Организация"].nunique(), ""),
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
            "Разные штатные должности у одного сотрудника",
            int((role_conflicts > 1).sum()),
            "должно быть 0: должность — атрибут человека",
        ),
        (
            "Разные организации у одного сотрудника",
            int((org_conflicts > 1).sum()),
            "должно быть 0",
        ),
        ("Проектов с несколькими блоками", int((owners > 1).sum()), "должно быть 0"),
        ("Дублей назначений", int((duplicates > 1).sum()), "должно быть 0"),
        (
            "Проектных ролей вне классификатора",
            int((people["Уровень роли №"] == -1).sum()),
            "дополнить ROLE_LEVELS в скрипте",
        ),
        (
            "Должностей вне классификатора грейдов",
            int((people["Грейд №"] == -1).sum()),
            "дополнить GRADE_RULES в скрипте",
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
        "Сотрудник", "Организация", "Проектная роль", "Уровень роли",
        "Штатная должность", "Грейд", "Блок", "Проект", "Руководитель",
        "ЗП", "ЗП подтверждена", "База сравнения", "Уровень сравнения",
        "Compa-ratio", "Отклонение руб", "Z-score",
        "Медиана грейда", "Compa-ratio к должности", "Разрыв должность − роль, руб",
        "Флаг ЗП", "Тип отклонения", "Требует внимания", "Доплата до порога",
        "Назначений у сотрудника", "Проектов у сотрудника",
    ]
    return people[columns].sort_values("Отклонение руб")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="исходный .xlsx")
    parser.add_argument("--out", type=Path, default=Path("datalens_dataset"))
    parser.add_argument(
        "--sheet",
        default=0,
        help="имя или номер листа с данными (по умолчанию первый)",
    )
    parser.add_argument(
        "--snapshot",
        default="",
        help="дата среза в формате ГГГГ-ММ-ДД; заполняет столбец «Дата среза»",
    )
    args = parser.parse_args()

    sheet = int(args.sheet) if str(args.sheet).isdigit() else args.sheet
    raw = load_source(args.source, sheet)
    assignments = build_assignments(raw)
    if args.snapshot:
        assignments.insert(0, "Дата среза", args.snapshot)

    csv_path = args.out.with_suffix(".csv")
    assignments.to_csv(csv_path, index=False, encoding="utf-8-sig")

    scored = assignments[assignments["В анализе справедливости"] == 1]
    roles = (
        scored.groupby(["Уровень роли №", "Уровень роли", "Проектная роль"])["ЗП"]
        .agg(["count", "min", "median", "mean", "max", "std"])
        .round(0)
    )
    grades = (
        scored.groupby(["Грейд №", "Грейд"])["ЗП"]
        .agg(["count", "min", "median", "mean", "max", "std"])
        .round(0)
    )

    xlsx_path = args.out.with_suffix(".xlsx")
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        assignments.to_excel(writer, sheet_name="Назначения", index=False)
        build_people_sheet(assignments).to_excel(writer, sheet_name="Сотрудники", index=False)
        roles.to_excel(writer, sheet_name="Роли")
        grades.to_excel(writer, sheet_name="Грейды")
        (
            pd.crosstab(scored["Проектная роль"], scored["Грейд"])
            .to_excel(writer, sheet_name="Роль x грейд")
        )
        (
            scored.groupby("Тип отклонения")
            .agg(людей=("Сотрудник", "count"), медиана_ЗП=("ЗП", "median"))
            .round(0)
            .to_excel(writer, sheet_name="Типы отклонений")
        )
        build_checks(assignments).to_excel(writer, sheet_name="Проверки", index=False)

    print(f"Записано: {csv_path}  ({len(assignments)} строк)")
    print(f"Записано: {xlsx_path}")
    print()
    print(build_checks(assignments).to_string(index=False))

    # Проверка классификации: медианы по грейдам обязаны расти монотонно.
    # Если нет — грейд назначен неверно, и на нём нельзя строить сравнение.
    for label, table, rules in (
        ("уровням роли", roles.groupby(level=0)["median"].median(), "ROLE_LEVELS"),
        ("грейдам", grades["median"], "GRADE_RULES"),
    ):
        medians = table.tolist()
        monotone = all(a <= b for a, b in zip(medians, medians[1:]))
        print()
        print(
            f"Медианы по {label}:",
            " → ".join(f"{m:,.0f}".replace(",", " ") for m in medians),
        )
        print("Монотонность:", "ОК" if monotone else f"НАРУШЕНА — проверьте {rules}")

    print()
    print("Типы отклонений:")
    print(scored["Тип отклонения"].value_counts().sort_index().to_string())


if __name__ == "__main__":
    main()
