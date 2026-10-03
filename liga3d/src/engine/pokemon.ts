import { getMove } from '../data/moves';
import { NATURES, natureMultiplier } from '../data/natures';
import { getSpecies, STAT_KEYS, type Evolution, type GrowthRate, type Species, type StatKey, type Stats } from '../data/species';
import type { MoveSlot, Pokemon } from './model';
import { randInt, type Rng } from './rng';

export const SHINY_CHANCE = 1 / 512;
export const MAX_LEVEL = 100;
export const MAX_EV = 252;
export const MAX_EV_TOTAL = 510;

export function zeroStats(): Stats {
  return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
}

export function expForLevel(growth: GrowthRate, level: number): number {
  if (level <= 1) return 0;
  const n = level;
  switch (growth) {
    case 'fast':
      return Math.floor((4 * n ** 3) / 5);
    case 'mediumFast':
      return n ** 3;
    case 'mediumSlow':
      return Math.max(0, Math.floor((6 / 5) * n ** 3 - 15 * n ** 2 + 100 * n - 140));
    case 'slow':
      return Math.floor((5 * n ** 3) / 4);
    case 'erratic':
      if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
      if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
      if (n <= 98) return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
      return Math.floor((n ** 3 * (160 - n)) / 100);
    case 'fluctuating':
      if (n <= 15) return Math.floor((n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return Math.floor((n ** 3 * (n + 14)) / 50);
      return Math.floor((n ** 3 * (Math.floor(n / 2) + 32)) / 50);
  }
}

export function calcStat(species: Species, p: Pick<Pokemon, 'level' | 'ivs' | 'evs' | 'nature'>, stat: StatKey): number {
  const base = species.base[stat];
  const core = Math.floor(((2 * base + p.ivs[stat] + Math.floor(p.evs[stat] / 4)) * p.level) / 100);
  if (stat === 'hp') return core + p.level + 10;
  return Math.floor((core + 5) * natureMultiplier(p.nature, stat));
}

export function calcStats(p: Pokemon): Stats {
  const sp = getSpecies(p.species);
  const out = zeroStats();
  for (const k of STAT_KEYS) out[k] = calcStat(sp, p, k);
  return out;
}

export function maxHp(p: Pokemon): number {
  return calcStat(getSpecies(p.species), p, 'hp');
}

export function displayName(p: Pokemon): string {
  return p.nickname || getSpecies(p.species).name;
}

/** Last four moves learnable at or below the level. */
export function defaultMoves(speciesId: number, level: number): MoveSlot[] {
  const ls = getSpecies(speciesId).learnset.filter(([lvl]) => lvl <= level);
  const ids: string[] = [];
  for (const [, mv] of ls) {
    const i = ids.indexOf(mv);
    if (i >= 0) ids.splice(i, 1);
    ids.push(mv);
  }
  return ids.slice(-4).map(makeSlot);
}

export function makeSlot(id: string): MoveSlot {
  const pp = getMove(id).pp;
  return { id, pp, maxPp: pp };
}

export interface CreateOptions {
  uid: string;
  ball?: string;
  metAt?: string;
  shiny?: boolean;
  ivs?: Partial<Stats>;
  nature?: string;
}

export function createPokemon(speciesId: number, level: number, rng: Rng, opts: CreateOptions): Pokemon {
  const sp = getSpecies(speciesId);
  const ivs = zeroStats();
  for (const k of STAT_KEYS) ivs[k] = opts.ivs?.[k] ?? randInt(rng, 0, 31);
  const nature = opts.nature ?? NATURES[randInt(rng, 0, NATURES.length - 1)].id;
  const gender = sp.male === null ? null : rng() < sp.male ? 'M' : 'F';
  const shiny = opts.shiny ?? rng() < SHINY_CHANCE;
  const p: Pokemon = {
    uid: opts.uid,
    species: speciesId,
    level,
    exp: expForLevel(sp.growth, level),
    nature,
    ivs,
    evs: zeroStats(),
    gender,
    shiny,
    hp: 1,
    status: null,
    sleepTurns: 0,
    moves: defaultMoves(speciesId, level),
    ball: opts.ball ?? 'poke-ball',
    metAt: opts.metAt ?? '',
    metLevel: level,
  };
  p.hp = maxHp(p);
  return p;
}

export function healFully(p: Pokemon): void {
  p.hp = maxHp(p);
  p.status = null;
  p.sleepTurns = 0;
  for (const m of p.moves) m.pp = m.maxPp;
}

export function isFainted(p: Pokemon): boolean {
  return p.hp <= 0;
}

export function ivTotal(p: Pokemon): number {
  return STAT_KEYS.reduce((s, k) => s + p.ivs[k], 0);
}

/** Percent of the maximum possible genes (186). */
export function ivPercent(p: Pokemon): number {
  return Math.round((ivTotal(p) / (31 * 6)) * 100);
}

export function expProgress(p: Pokemon): { current: number; needed: number; ratio: number } {
  const sp = getSpecies(p.species);
  if (p.level >= MAX_LEVEL) return { current: 0, needed: 0, ratio: 1 };
  const lo = expForLevel(sp.growth, p.level);
  const hi = expForLevel(sp.growth, p.level + 1);
  const current = p.exp - lo;
  const needed = hi - lo;
  return { current, needed, ratio: needed > 0 ? Math.min(1, current / needed) : 1 };
}

export interface LevelUpResult {
  levels: number[];
  /** Moves learned automatically (free slot). */
  learned: string[];
  /** Moves waiting for a decision (all four slots full). */
  pending: string[];
}

/** Adds experience and processes level ups, keeping damage taken. */
export function gainExp(p: Pokemon, amount: number): LevelUpResult {
  const sp = getSpecies(p.species);
  const res: LevelUpResult = { levels: [], learned: [], pending: [] };
  if (p.level >= MAX_LEVEL) return res;
  p.exp = Math.min(p.exp + amount, expForLevel(sp.growth, MAX_LEVEL));
  while (p.level < MAX_LEVEL && p.exp >= expForLevel(sp.growth, p.level + 1)) {
    const oldMax = maxHp(p);
    p.level += 1;
    if (p.hp > 0) p.hp += maxHp(p) - oldMax;
    res.levels.push(p.level);
    for (const mv of movesLearnedAt(p.species, p.level)) {
      if (p.moves.some((m) => m.id === mv)) continue;
      if (p.moves.length < 4) {
        p.moves.push(makeSlot(mv));
        res.learned.push(mv);
      } else {
        res.pending.push(mv);
      }
    }
  }
  return res;
}

export function movesLearnedAt(speciesId: number, level: number): string[] {
  return getSpecies(speciesId).learnset.filter(([lvl]) => lvl === level).map(([, mv]) => mv);
}

/** EV yield: the defeated species' best stat, 1-3 points depending on evolution stage. */
export function evYield(speciesId: number): Partial<Stats> {
  const sp = getSpecies(speciesId);
  let best: StatKey = 'hp';
  for (const k of STAT_KEYS) if (sp.base[k] > sp.base[best]) best = k;
  return { [best]: sp.stage };
}

export function addEvs(p: Pokemon, gain: Partial<Stats>): void {
  for (const k of STAT_KEYS) {
    const add = gain[k] ?? 0;
    if (!add) continue;
    const total = STAT_KEYS.reduce((s, x) => s + p.evs[x], 0);
    const room = Math.min(MAX_EV - p.evs[k], MAX_EV_TOTAL - total);
    if (room <= 0) continue;
    const oldMax = maxHp(p);
    p.evs[k] += Math.min(add, room);
    if (k === 'hp' && p.hp > 0) p.hp += maxHp(p) - oldMax;
  }
}

export function timeOfDay(date = new Date()): 'day' | 'night' {
  const h = date.getHours();
  return h >= 6 && h < 18 ? 'day' : 'night';
}

function conditionsMet(p: Pokemon, e: Evolution, now: Date): boolean {
  if (e.time && e.time !== timeOfDay(now)) return false;
  if (e.gender && e.gender !== p.gender) return false;
  if (e.physical !== undefined) {
    const s = calcStats(p);
    const rel = Math.sign(s.atk - s.def);
    if (rel !== e.physical) return false;
  }
  return true;
}

/** Picks one of several equally valid evolutions (Wurmple, Toxel…) deterministically per pokemon. */
function pickStable(p: Pokemon, list: Evolution[]): Evolution | null {
  if (!list.length) return null;
  const conditioned = list.filter((e) => e.time || e.gender || e.physical !== undefined);
  const pool = conditioned.length ? conditioned : list;
  let h = 0;
  for (const ch of p.uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

export function levelEvolution(p: Pokemon, now = new Date()): number | null {
  const list = getSpecies(p.species).evolutions.filter((e) => e.level !== undefined && !e.item && p.level >= e.level && conditionsMet(p, e, now));
  return pickStable(p, list)?.to ?? null;
}

export function itemEvolution(p: Pokemon, itemId: string, now = new Date()): number | null {
  const list = getSpecies(p.species).evolutions.filter((e) => e.item === itemId && conditionsMet(p, e, now));
  return pickStable(p, list)?.to ?? null;
}

/** Changes species in place, keeping the same HP ratio of damage taken. */
export function evolve(p: Pokemon, to: number): string[] {
  const oldMax = maxHp(p);
  p.species = to;
  if (p.hp > 0) p.hp = Math.max(1, p.hp + (maxHp(p) - oldMax));
  return movesLearnedAt(to, p.level).filter((mv) => !p.moves.some((m) => m.id === mv));
}
