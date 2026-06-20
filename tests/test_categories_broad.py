"""
Тест (v54.3): расширение словаря по ВСЕМ категориям (косметика, спорт, игрушки,
зоотовары, мебель, свет, бытовая химия, канцелярия, текстиль, посуда).

Проверяем, что частые на WB товары корректно относятся к своей категории и что
расширение не создаёт ложных пересечений между категориями.

Запуск:  python3 tests/test_categories_broad.py
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("webview", types.ModuleType("webview"))

import main_v39 as m  # noqa: E402

RESULTS = []


def check(name, cond):
    RESULTS.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}")


SAMPLES = [
    ("Тушь для ресниц объёмная", "cosmetics"), ("Помада матовая стойкая", "cosmetics"),
    ("Сыворотка для лица", "cosmetics"), ("Гель-лак для ногтей", "cosmetics"),
    ("Крем для рук питательный", "cosmetics"), ("Тональный крем", "cosmetics"),
    ("Обруч массажный хулахуп", "sport_equipment"), ("Утяжелители для ног", "sport_equipment"),
    ("Эспандер кистевой", "sport_equipment"), ("Фитнес резинки для тренировок", "sport_equipment"),
    ("Очки для плавания", "sport_equipment"), ("Батут с сеткой", "sport_equipment"),
    ("Кукла Барби", "toys"), ("Слайм лизун", "toys"), ("Конструктор магнитный", "toys"),
    ("Пупс интерактивный", "toys"), ("Кинетический песок", "toys"), ("Раскраска для детей", "toys"),
    ("Когтеточка для кошек", "pet"), ("Сухой корм для собак", "pet"),
    ("Шлейка для собаки", "pet"), ("Лежанка для кошки", "pet"),
    ("Кровать двуспальная", "furniture"), ("Стол компьютерный", "furniture"),
    ("Тумба прикроватная", "furniture"), ("Шкаф-купе", "furniture"),
    ("Светодиодная лента 5м", "lighting"), ("Ночник детский", "lighting"),
    ("Торшер напольный", "lighting"), ("Гирлянда новогодняя", "lighting"),
    ("Гель для мытья посуды", "household_chemistry"), ("Капсулы для стирки", "household_chemistry"),
    ("Пятновыводитель", "household_chemistry"), ("Кондиционер для белья", "household_chemistry"),
    ("Ежедневник недатированный", "stationery"), ("Скетчбук А5", "stationery"),
    ("Пенал школьный", "stationery"), ("Фломастеры 12 цветов", "stationery"),
    ("Скалка силиконовая", "kitchenware"), ("Ланч-бокс", "kitchenware"), ("Штопор", "kitchenware"),
    ("Постельное белье евро", "home_textile"), ("Плед флисовый", "home_textile"),
    ("Штора блэкаут", "home_textile"), ("Наволочка 50х70", "home_textile"),
]


def main():
    for pn, cat in SAMPLES:
        check(f"{pn!r} → {cat}", cat in m._detect_categories(pn))

    # cross-category: реальные конфликты сохраняются, ложных нет
    def v(pn, cert):
        return m.compare_product_names(pn, cert, "", "", "Действует")[0]
    check("платье vs игрушки → НЕСООТВЕТСТВИЕ",
          v("Платье женское", "Игрушки мягконабивные") == "НЕСООТВЕТСТВИЕ")
    check("крем для рук vs косметика → OK",
          v("Крем для рук увлажняющий", "Продукция косметическая для ухода за кожей") == "OK")
    check("корм для собак vs зоотовары → не несоответствие",
          v("Сухой корм для собак 10 кг", "Корма для непродуктивных животных") != "НЕСООТВЕТСТВИЕ")
    check("светильник vs светотехника → не несоответствие",
          v("Светодиодная лента 5м", "Приборы осветительные светодиодные") != "НЕСООТВЕТСТВИЕ")


if __name__ == "__main__":
    main()
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
