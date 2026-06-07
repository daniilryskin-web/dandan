"""
Тест логики сравнения: «мягкий» конфликт слоя одежды -> ПРОВЕРИТЬ ВРУЧНУЮ.

По решению пользователя: узкий сертификат (напр. «бельё первого слоя») против
ДРУГОГО вида одежды (костюм/свитшот/платье) — это не доказанное несоответствие
и не авто-OK, а повод ПРОВЕРИТЬ ВРУЧНУЮ. При этом:
  - трусы/бельё против бельевого сертификата -> OK (тот же слой);
  - ШИРОКИЙ сертификат на детскую одежду по-прежнему покрывает костюм/свитшот;
  - жёсткие конфликты (другая товарная группа) -> НЕСООТВЕТСТВИЕ.

Запуск:  python3 tests/test_compare_layers.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main_v39 as m  # noqa: E402

RESULTS = []
CERT_BELYE = ("Изделия трикотажные бельевые первого слоя для детей дошкольного, "
              "школьного возраста и подростков")
CERT_BROAD = "Изделия трикотажные для детей дошкольного и школьного возраста"


def check(name, got, exp):
    ok = (got == exp)
    RESULTS.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {got} (ожид. {exp})")


def verdict(card, cert):
    return m.compare_product_names(card, cert, doc_status="Действует")[0]


# Узкий бельевой сертификат vs другой вид одежды -> ПРОВЕРИТЬ ВРУЧНУЮ (согласованно)
for card in ["Костюм для девочки", "Свитшот для мальчика", "Платье для девочки"]:
    check(f"бельё × «{card}»", verdict(card, CERT_BELYE), "ПРОВЕРИТЬ ВРУЧНУЮ")

# Бельё (тот же слой) -> OK
check("бельё × «Трусы детские»", verdict("Трусы детские", CERT_BELYE), "OK")

# Широкий сертификат покрывает -> OK
check("широкий × «Костюм для девочки»", verdict("Костюм для девочки", CERT_BROAD), "OK")
check("широкий × «Свитшот для мальчика»", verdict("Свитшот для мальчика", CERT_BROAD), "OK")

# Жёсткий доменный конфликт -> НЕСООТВЕТСТВИЕ
check("бельё × «Кукла детская»", verdict("Кукла детская", CERT_BELYE), "НЕСООТВЕТСТВИЕ")

# «бельё первого слоя» НЕ считается широкой одеждой
check("broad(бельё первого слоя)=False", m._contains_broad_child_clothing(CERT_BELYE), False)
check("broad(трикотажные для детей)=True", m._contains_broad_child_clothing(CERT_BROAD), True)

if __name__ == "__main__":
    p, t = sum(RESULTS), len(RESULTS)
    print("-" * 60)
    print(f"ИТОГО: {p}/{t} прошло")
    sys.exit(0 if p == t else 1)
