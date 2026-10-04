# Источники данных

Данные игры генерирует `scripts/build-data.mjs` в `src/data/gen/species.json` и `src/data/gen/moves.json`:

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/PokeAPI/pokeapi
(cd pokeapi && git sparse-checkout set data/v2/csv)
git clone --depth 1 https://github.com/sindresorhus/pokemon
npm run build-data -- pokeapi/data/v2/csv pokemon
```

- **PokeAPI** (BSD-3-Clause) — 1025 видов: характеристики, типы, шанс поимки, скорость роста, пол, рост, вес,
  эволюции, списки атак по уровням (берётся самая новая игра, где они есть: Scarlet/Violet → Sword/Shield → …),
  атаки и их механика (`move_meta`: статусы, изменения характеристик, вампиризм, отдача, лечение, криты, серии).
- **sindresorhus/pokemon** (MIT) — русские имена покемонов; недостающие имена — в `species-names-ru.txt`.
- `move-names-ru.txt` — русские названия атак, переведённые для этой игры.

Статусные атаки, механику которых движок пока не поддерживает, не попадают в списки атак покемонов.

Таблицы с Kaggle, по которым сверялись данные первой версии (характеристики всех видов совпадают с PokeAPI):

- `pokemon.csv` — «The Complete Pokemon Dataset» (801 покемон, поколения 1–7). У части записей стоят значения
  мега-эволюций и алольских форм вместо обычных.
- `pokemon-stats.csv` — «Pokemon with stats» (800 записей, поколения 1–6, мега-формы отдельными строками).
- `pokemon-species.csv` — 807 видов (поколения 1–7), только обычные формы, с базовым опытом.
- `pokemon-gen9.csv` — 1025 видов и альтернативные формы; по нему `scripts/import-sprites.mjs` сопоставляет
  имена файлов картинок.
