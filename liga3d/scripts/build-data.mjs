// Generates src/data/gen/{species,moves}.json from a local PokeAPI checkout.
//
// Usage: node scripts/build-data.mjs <path-to-pokeapi>/data/v2/csv [path-to-sindresorhus-pokemon]
//
// Sources:
//  - PokeAPI (https://github.com/PokeAPI/pokeapi, BSD-3-Clause): stats, types, learnsets, evolutions, moves.
//  - sindresorhus/pokemon (MIT): Russian species names (data/ru.json).
//  - data-src/move-names-ru.txt: Russian move names made for this game.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csvDir = process.argv[2];
const namesDir = process.argv[3] ?? join(root, '..', '..', 'sindresorhus', 'pokemon');
if (!csvDir || !existsSync(join(csvDir, 'pokemon_species.csv'))) {
  console.error('Укажите путь к PokeAPI data/v2/csv');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}
const load = (name) => parseCsv(readFileSync(join(csvDir, name), 'utf8'));
const num = (v) => (v === '' || v === undefined ? null : Number(v));

const TYPES = { 1: 'normal', 2: 'fighting', 3: 'flying', 4: 'poison', 5: 'ground', 6: 'rock', 7: 'bug', 8: 'ghost', 9: 'steel', 10: 'fire', 11: 'water', 12: 'grass', 13: 'electric', 14: 'psychic', 15: 'ice', 16: 'dragon', 17: 'dark', 18: 'fairy' };
const GROWTH = { 1: 'slow', 2: 'mediumFast', 3: 'fast', 4: 'mediumSlow', 5: 'erratic', 6: 'fluctuating' };
const STAT = { 1: 'hp', 2: 'atk', 3: 'def', 4: 'spa', 5: 'spd', 6: 'spe', 7: 'acc', 8: 'eva' };
const AILMENT = { 1: 'par', 2: 'slp', 3: 'frz', 4: 'brn', 5: 'psn' };
const COLORS = { 1: 'black', 2: 'blue', 3: 'brown', 4: 'gray', 5: 'green', 6: 'pink', 7: 'purple', 8: 'red', 9: 'white', 10: 'yellow' };
const SHAPES = { 1: 'ball', 2: 'squiggle', 3: 'fish', 4: 'arms', 5: 'blob', 6: 'upright', 7: 'legs', 8: 'quadruped', 9: 'wings', 10: 'tentacles', 11: 'heads', 12: 'humanoid', 13: 'bug-wings', 14: 'armor' };
const SELF_TARGETS = new Set([4, 5, 7, 13, 15]);
const FIXED = { 'seismic-toss': 'level', 'night-shade': 'level', 'dragon-rage': 40, 'sonic-boom': 20, 'super-fang': 'half', 'natures-madness': 'half', ruination: 'half' };
const RECHARGE = new Set(['hyper-beam', 'giga-impact', 'blast-burn', 'hydro-cannon', 'frenzy-plant', 'rock-wrecker', 'roar-of-time', 'prismatic-laser', 'eternabeam', 'meteor-assault']);
const SELF_KO = new Set(['self-destruct', 'explosion', 'memento', 'final-gambit', 'misty-explosion', 'healing-wish', 'lunar-dance']);
const SKIP_MOVE = (id) => id.includes('--') || id.startsWith('max-') || id === 'g-max' || /^(catastropika|10-000-000-volt-thunderbolt|sinister-arrow-raid|malicious-moonsault|oceanic-operetta|guardian-of-alola|soul-stealing-7-star-strike|stoked-sparksurfer|pulverizing-pancake|extreme-evoboost|genesis-supernova|light-that-burns-the-sky|searing-sunraze-smash|menacing-moonraze-maelstrom|lets-snuggle-forever|splintered-stormshards|clangorous-soulblaze)$/.test(id);

// ——— names ———
const ruSpecies = JSON.parse(readFileSync(join(namesDir, 'data', 'ru.json'), 'utf8'));
for (const line of readFileSync(join(root, 'data-src/species-names-ru.txt'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const [no, name] = line.split('|').map((x) => x.trim());
  ruSpecies[Number(no) - 1] = name;
}
const ruMoves = new Map(
  readFileSync(join(root, 'data-src/move-names-ru.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('|').map((x) => x.trim())),
);
const enNames = (file, idCol) => {
  const m = new Map();
  for (const r of load(file)) if (r.local_language_id === '9') m.set(r[idCol], r.name);
  return m;
};
const enSpecies = enNames('pokemon_species_names.csv', 'pokemon_species_id');
const enMoves = enNames('move_names.csv', 'move_id');

// ——— moves ———
const meta = new Map(load('move_meta.csv').map((r) => [r.move_id, r]));
const statChanges = new Map();
for (const r of load('move_meta_stat_changes.csv')) {
  if (!statChanges.has(r.move_id)) statChanges.set(r.move_id, {});
  statChanges.get(r.move_id)[STAT[r.stat_id]] = Number(r.change);
}

const moves = [];
const moveById = new Map();
for (const r of load('moves.csv')) {
  const id = Number(r.id);
  if (id >= 10000 || SKIP_MOVE(r.identifier)) continue;
  const type = TYPES[r.type_id];
  if (!type) continue;
  const cat = { 1: 'status', 2: 'physical', 3: 'special' }[r.damage_class_id];
  const m = meta.get(r.id);
  const fx = {};
  const target = Number(r.target_id);
  let implemented = cat !== 'status';
  if (m) {
    const ailment = AILMENT[m.meta_ailment_id];
    const ailChance = Number(m.ailment_chance) || (cat === 'status' ? 100 : 0);
    if (ailment && ailChance) {
      fx.status = { id: ailment, chance: ailChance };
      implemented = true;
    }
    if (m.meta_ailment_id === '6') {
      fx.confuse = Number(m.ailment_chance) || (cat === 'status' ? 100 : 0);
      implemented = true;
    }
    const sc = statChanges.get(r.id);
    if (sc) {
      const toSelf = SELF_TARGETS.has(target) || m.meta_category_id === '7';
      fx.stats = { target: toSelf ? 'self' : 'foe', changes: sc, chance: Number(m.stat_chance) || 100 };
      implemented = true;
    }
    const drain = Number(m.drain);
    if (drain > 0) fx.drain = drain / 100;
    if (drain < 0) fx.recoil = -drain / 100;
    const heal = Number(m.healing);
    if (heal > 0 && cat === 'status') {
      fx.heal = heal / 100;
      implemented = true;
    }
    if (Number(m.crit_rate) >= 1) fx.highCrit = true;
    if (Number(m.flinch_chance)) fx.flinch = Number(m.flinch_chance);
    if (m.min_hits && m.max_hits) fx.multiHit = [Number(m.min_hits), Number(m.max_hits)];
    if (m.meta_category_id === '9') {
      fx.ohko = true;
      implemented = true;
    }
  }
  if (FIXED[r.identifier] !== undefined) fx.fixedDamage = FIXED[r.identifier];
  if (RECHARGE.has(r.identifier)) fx.recharge = true;
  if (SELF_KO.has(r.identifier) && cat !== 'status') fx.selfKO = true;
  if (r.identifier === 'rest') { fx.rest = true; implemented = true; }
  if (r.identifier === 'teleport') { fx.flee = true; implemented = true; }
  if (r.identifier === 'pay-day' || r.identifier === 'make-it-rain') fx.payDay = true;
  if (['hex', 'infernal-parade', 'bitter-malice'].includes(r.identifier)) fx.hex = true;
  if (['protect', 'detect', 'kings-shield', 'spiky-shield', 'baneful-bunker', 'obstruct', 'silk-trap', 'burning-bulwark'].includes(r.identifier)) {
    fx.protect = true;
    implemented = true;
  }
  if (r.identifier === 'splash' || r.identifier === 'celebrate' || r.identifier === 'hold-hands') implemented = true;
  const ru = ruMoves.get(r.identifier) ?? enMoves.get(r.id) ?? r.identifier;
  const move = {
    id: r.identifier,
    name: ru,
    en: enMoves.get(r.id) ?? r.identifier,
    type,
    category: cat,
    power: num(r.power) ?? 0,
    accuracy: num(r.accuracy),
    pp: num(r.pp) ?? 5,
    priority: Number(r.priority) || 0,
    effect: fx,
  };
  if (!implemented) continue;
  moves.push(move);
  moveById.set(r.id, move);
}
// Struggle is used when no PP is left.
const struggle = moves.find((m) => m.id === 'struggle');
if (struggle) Object.assign(struggle.effect, { recoil: 0.25 }), (struggle.accuracy = null);

// ——— species ———
const pokemon = new Map(load('pokemon.csv').map((r) => [r.id, r]));
const stats = new Map();
for (const r of load('pokemon_stats.csv')) {
  if (!stats.has(r.pokemon_id)) stats.set(r.pokemon_id, {});
  stats.get(r.pokemon_id)[STAT[r.stat_id]] = Number(r.base_stat);
}
const types = new Map();
for (const r of load('pokemon_types.csv')) {
  if (!types.has(r.pokemon_id)) types.set(r.pokemon_id, []);
  types.get(r.pokemon_id)[Number(r.slot) - 1] = TYPES[r.type_id];
}
const itemsById = new Map(load('items.csv').map((r) => [r.id, r.identifier]));

const VG_PRIORITY = [25, 27, 26, 20, 21, 22, 23, 30, 31, 32, 18, 17, 16, 15, 14, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 19, 24, 12, 13];
const learn = new Map(); // pokemonId -> vg -> [[lvl, moveId]]
for (const r of load('pokemon_moves.csv')) {
  if (r.pokemon_move_method_id !== '1') continue;
  const pid = Number(r.pokemon_id);
  if (pid > 1025) continue;
  if (!learn.has(pid)) learn.set(pid, new Map());
  const byVg = learn.get(pid);
  const vg = Number(r.version_group_id);
  if (!byVg.has(vg)) byVg.set(vg, []);
  byVg.get(vg).push([Number(r.level), r.move_id]);
}

const speciesRows = load('pokemon_species.csv').filter((r) => Number(r.id) <= 1025);
const evoRows = load('pokemon_evolution.csv');
const speciesById = new Map(speciesRows.map((r) => [r.id, r]));

function evoFor(row) {
  const trig = row.evolution_trigger_id;
  const item = row.trigger_item_id ? itemsById.get(row.trigger_item_id) : null;
  const held = row.held_item_id ? itemsById.get(row.held_item_id) : null;
  const e = {};
  if (row.time_of_day === 'day' || row.time_of_day === 'night') e.time = row.time_of_day;
  if (row.gender_id === '1') e.gender = 'F';
  if (row.gender_id === '2') e.gender = 'M';
  if (row.relative_physical_stats !== '') e.physical = Number(row.relative_physical_stats);
  switch (trig) {
    case '3':
      if (item) e.item = item;
      break;
    case '1':
      if (held) e.item = held;
      else if (row.minimum_level) e.level = Number(row.minimum_level);
      else if (row.known_move_type_id) e.item = 'shiny-stone';
      else if (row.minimum_happiness || row.minimum_affection) e.item = 'soothe-bell';
      else if (row.location_id) e.item = 'thunder-stone';
      else e.level = 32;
      break;
    case '2':
      e.item = held ?? (row.trade_species_id ? null : 'linking-cord');
      if (!e.item) { delete e.item; e.level = 30; }
      break;
    case '5':
      e.item = item ?? 'strawberry-sweet';
      break;
    case '6':
      e.item = 'scroll-of-darkness';
      break;
    case '7':
      e.item = 'scroll-of-waters';
      break;
    default:
      e.level = row.minimum_level ? Number(row.minimum_level) : 36;
  }
  if (!e.item && !e.level) e.level = 30;
  return e;
}
const RANK = (row) => ({ '3': 0, '1': row.minimum_level ? 1 : 2, '2': 3 }[row.evolution_trigger_id] ?? 4);
const evoByTarget = new Map();
for (const row of evoRows) {
  const prev = evoByTarget.get(row.evolved_species_id);
  if (!prev || RANK(row) < RANK(prev)) evoByTarget.set(row.evolved_species_id, row);
}

function stageOf(id) {
  let s = 1;
  let cur = speciesById.get(String(id));
  while (cur && cur.evolves_from_species_id) {
    s++;
    cur = speciesById.get(cur.evolves_from_species_id);
  }
  return s;
}

const species = [];
const usedItems = new Set();
for (const s of speciesRows) {
  const id = Number(s.id);
  const p = pokemon.get(s.id);
  const st = stats.get(s.id);
  const ty = types.get(s.id).filter(Boolean);
  // Level-up learnset from the newest game that has one; drops unimplemented moves.
  let ls = [];
  const byVg = learn.get(id);
  if (byVg) {
    for (const vg of VG_PRIORITY) {
      if (byVg.has(vg)) {
        ls = byVg.get(vg);
        break;
      }
    }
  }
  const seen = new Set();
  let learnset = ls
    .map(([lvl, mid]) => [Math.max(1, lvl), moveById.get(mid)?.id])
    .filter(([, mv]) => mv && !seen.has(mv) && seen.add(mv))
    .sort((a, b) => a[0] - b[0]);
  if (!learnset.length || learnset[0][0] > 1) learnset = [[1, ty.includes('normal') ? 'tackle' : moves.find((m) => m.type === ty[0] && m.category !== 'status' && m.power > 0 && m.power <= 40)?.id ?? 'tackle'], ...learnset];
  const evolutions = speciesRows
    .filter((x) => x.evolves_from_species_id === s.id)
    .map((x) => {
      const row = evoByTarget.get(x.id);
      const e = row ? evoFor(row) : { level: 30 };
      if (e.item) usedItems.add(e.item);
      return { to: Number(x.id), ...e };
    });
  const genderRate = Number(s.gender_rate);
  species.push({
    id,
    name: ruSpecies[id - 1],
    en: enSpecies.get(s.id) ?? s.identifier,
    types: ty,
    base: [st.hp, st.atk, st.def, st.spa, st.spd, st.spe],
    catch: Number(s.capture_rate),
    exp: Number(p.base_experience) || 50,
    growth: GROWTH[s.growth_rate_id],
    male: genderRate < 0 ? null : 1 - genderRate / 8,
    stage: stageOf(id),
    evolutions,
    learnset,
    height: Number(p.height) / 10,
    weight: Number(p.weight) / 10,
    color: COLORS[s.color_id] ?? 'gray',
    shape: SHAPES[s.shape_id] ?? 'blob',
    gen: Number(s.generation_id),
    legendary: s.is_legendary === '1' ? 1 : 0,
    mythical: s.is_mythical === '1' ? 1 : 0,
    baby: s.is_baby === '1' ? 1 : 0,
    from: s.evolves_from_species_id ? Number(s.evolves_from_species_id) : null,
  });
}

const out = join(root, 'src/data/gen');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'moves.json'), JSON.stringify(moves));
writeFileSync(join(out, 'species.json'), JSON.stringify(species));
console.log(`moves: ${moves.length}, species: ${species.length}`);
console.log(`evolution items: ${[...usedItems].sort().join(', ')}`);
const untranslated = moves.filter((m) => !ruMoves.has(m.id)).map((m) => m.id);
console.log(`moves without Russian name: ${untranslated.length}${untranslated.length ? ' — ' + untranslated.slice(0, 30).join(', ') : ''}`);
