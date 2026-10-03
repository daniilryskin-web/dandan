import type { PokeType } from './types';
import speciesJson from './gen/species.json?raw';
import { CURATED_LOOKS } from './looks';

export type GrowthRate = 'fast' | 'mediumFast' | 'mediumSlow' | 'slow' | 'erratic' | 'fluctuating';
export type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type Stats = Record<StatKey, number>;
export const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_LABELS: Record<StatKey, string> = {
  hp: 'HP', atk: 'Атака', def: 'Защита', spa: 'Сп. атака', spd: 'Сп. защита', spe: 'Скорость',
};

export type BodyShape = 'quad' | 'biped' | 'bird' | 'fish' | 'serpent' | 'blob' | 'larva';

/** Parameters for the procedural low-poly 3D model (offline fallback). */
export interface Look {
  shape: BodyShape;
  color: string;
  accent: string;
  belly?: string;
  ears?: 'pointy' | 'round' | 'long' | 'fin';
  tail?: 'flame' | 'leaf' | 'bolt' | 'thin' | 'fluffy' | 'fin' | 'stinger' | 'curl' | 'club';
  wings?: 'feather' | 'insect' | 'bat';
  horns?: number;
  shell?: boolean;
  bulb?: 'bud' | 'flower' | 'leaves' | 'mushroom';
  spikes?: boolean;
  arms?: boolean;
  floating?: boolean;
  beak?: boolean;
  mane?: boolean;
  gas?: boolean;
  magnet?: boolean;
  segments?: number;
  size: number;
}

export interface Evolution {
  to: number;
  level?: number;
  item?: string;
  time?: 'day' | 'night';
  gender?: 'M' | 'F';
  /** Tyrogue-style: 1 = Atk > Def, -1 = Atk < Def, 0 = equal. */
  physical?: number;
}

export interface Species {
  id: number;
  name: string;
  en: string;
  types: PokeType[];
  base: Stats;
  catchRate: number;
  baseExp: number;
  growth: GrowthRate;
  /** Probability of being male; null = genderless. */
  male: number | null;
  evolutions: Evolution[];
  learnset: [number, string][];
  look: Look;
  /** Evolution stage, 1..3 (used for EV yield and spawn rarity). */
  stage: number;
  /** Metres. */
  height: number;
  /** Kilograms. */
  weight: number;
  color: string;
  shape: string;
  gen: number;
  legendary: boolean;
  mythical: boolean;
  baby: boolean;
  from: number | null;
}

interface RawSpecies {
  id: number;
  name: string;
  en: string;
  types: PokeType[];
  base: [number, number, number, number, number, number];
  catch: number;
  exp: number;
  growth: GrowthRate;
  male: number | null;
  stage: number;
  evolutions: Evolution[];
  learnset: [number, string][];
  height: number;
  weight: number;
  color: string;
  shape: string;
  gen: number;
  legendary: number;
  mythical: number;
  baby: number;
  from: number | null;
}

const COLOR_HEX: Record<string, [string, string]> = {
  black: ['#3a3a44', '#d04040'], blue: ['#4f86d8', '#f2d06a'], brown: ['#a8774a', '#f1dfb8'], gray: ['#9aa0a8', '#5a606a'],
  green: ['#5fb06a', '#2f7a3f'], pink: ['#f2a8c4', '#ffffff'], purple: ['#8a5fc0', '#f2d06a'], red: ['#e0503a', '#ffcf4a'],
  white: ['#eef0f4', '#9aa8c0'], yellow: ['#f2cf3a', '#3a3a44'],
};
const SHAPE_BODY: Record<string, BodyShape> = {
  ball: 'blob', squiggle: 'serpent', fish: 'fish', arms: 'blob', blob: 'blob', upright: 'biped', legs: 'biped', quadruped: 'quad',
  wings: 'bird', tentacles: 'blob', heads: 'blob', humanoid: 'biped', 'bug-wings': 'bird', armor: 'biped',
};

/** Rough procedural look from the PokeAPI colour/shape when no hand-made look exists. */
function derivedLook(r: RawSpecies): Look {
  const [color, accent] = COLOR_HEX[r.color] ?? COLOR_HEX.gray;
  const shape = SHAPE_BODY[r.shape] ?? 'blob';
  const size = Math.max(0.45, Math.min(1.7, 0.45 + Math.log2(1 + r.height) * 0.55));
  const look: Look = { shape, color, accent, size };
  if (r.shape === 'bug-wings') look.wings = 'insect';
  if (r.shape === 'wings') look.wings = 'feather';
  if (r.shape === 'arms' || r.shape === 'tentacles') look.arms = true;
  if (r.shape === 'squiggle') look.segments = 7;
  if (r.types.includes('fire')) look.tail = 'flame';
  if (r.types.includes('ghost') && shape === 'blob') {
    look.floating = true;
    look.gas = true;
  }
  if (r.types.includes('grass') && shape !== 'bird') look.bulb = 'leaves';
  if (r.types.includes('rock') || r.types.includes('steel')) look.spikes = true;
  return look;
}

const RAW = JSON.parse(speciesJson) as RawSpecies[];

export const SPECIES: Record<number, Species> = {};
for (const r of RAW) {
  SPECIES[r.id] = {
    id: r.id,
    name: r.name,
    en: r.en,
    types: r.types,
    base: { hp: r.base[0], atk: r.base[1], def: r.base[2], spa: r.base[3], spd: r.base[4], spe: r.base[5] },
    catchRate: r.catch,
    baseExp: r.exp,
    growth: r.growth,
    male: r.male,
    evolutions: r.evolutions,
    learnset: r.learnset,
    look: CURATED_LOOKS[r.id] ?? derivedLook(r),
    stage: Math.min(3, r.stage),
    height: r.height,
    weight: r.weight,
    color: r.color,
    shape: r.shape,
    gen: r.gen,
    legendary: !!r.legendary,
    mythical: !!r.mythical,
    baby: !!r.baby,
    from: r.from,
  };
}

export const SPECIES_LIST: Species[] = Object.values(SPECIES).sort((a, b) => a.id - b.id);
export const MAX_SPECIES = SPECIES_LIST.length;

export function getSpecies(id: number): Species {
  const s = SPECIES[id];
  if (!s) throw new Error(`Unknown species: ${id}`);
  return s;
}

export function dexNo(id: number): string {
  return '#' + String(id).padStart(4, '0');
}

export function baseStatTotal(s: Species): number {
  return s.base.hp + s.base.atk + s.base.def + s.base.spa + s.base.spd + s.base.spe;
}
