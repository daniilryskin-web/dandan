import type { PokeType } from './types';
import movesJson from './gen/moves.json?raw';

export type MoveCategory = 'physical' | 'special' | 'status';
export type StatusId = 'brn' | 'psn' | 'par' | 'slp' | 'frz';
export type BattleStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva';

export interface MoveEffect {
  /** Inflict a major status on the target. */
  status?: { id: StatusId; chance: number };
  /** Confuse the target with this chance (%). */
  confuse?: number;
  /** Change stat stages of the user or the target. */
  stats?: { target: 'self' | 'foe'; changes: Partial<Record<BattleStat | 'hp', number>>; chance: number };
  flinch?: number;
  /** Fraction of dealt damage restored to the user. */
  drain?: number;
  /** Fraction of dealt damage the user takes back. */
  recoil?: number;
  /** Fraction of max HP the user restores (status moves). */
  heal?: number;
  multiHit?: [number, number];
  fixedDamage?: number | 'level' | 'half';
  highCrit?: boolean;
  rest?: boolean;
  flee?: boolean;
  payDay?: boolean;
  /** Power doubles if the target has a major status. */
  hex?: boolean;
  protect?: boolean;
  /** The user must rest on the next turn. */
  recharge?: boolean;
  /** The user faints after using the move. */
  selfKO?: boolean;
  /** One-hit KO. */
  ohko?: boolean;
}

export interface MoveData {
  id: string;
  name: string;
  en: string;
  type: PokeType;
  category: MoveCategory;
  power: number;
  /** null = never misses */
  accuracy: number | null;
  pp: number;
  priority: number;
  effect: MoveEffect;
}

const LIST = JSON.parse(movesJson) as MoveData[];

export const MOVES: Record<string, MoveData> = Object.fromEntries(LIST.map((mv) => [mv.id, mv]));
export const MOVE_LIST = LIST;

export function getMove(id: string): MoveData {
  const mv = MOVES[id];
  if (!mv) throw new Error(`Unknown move: ${id}`);
  return mv;
}

export const STAT_NAMES: Record<BattleStat | 'hp', string> = {
  hp: 'HP', atk: 'Атака', def: 'Защита', spa: 'Спец. атака', spd: 'Спец. защита', spe: 'Скорость', acc: 'Точность', eva: 'Уклонение',
};

export const STATUS_INFO: Record<StatusId, { name: string; short: string; color: string }> = {
  brn: { name: 'Ожог', short: 'ОЖГ', color: '#ee8130' },
  psn: { name: 'Отравление', short: 'ЯД', color: '#a33ea1' },
  par: { name: 'Паралич', short: 'ПАР', color: '#d4b000' },
  slp: { name: 'Сон', short: 'СОН', color: '#7f8c9a' },
  frz: { name: 'Заморозка', short: 'ЛЁД', color: '#5fc6d6' },
};
