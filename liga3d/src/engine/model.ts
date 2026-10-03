import type { BattleStat, StatusId } from '../data/moves';
import type { Stats } from '../data/species';
import type { Biome } from '../data/world';

export interface MoveSlot {
  id: string;
  pp: number;
  maxPp: number;
}

export interface Pokemon {
  uid: string;
  species: number;
  nickname?: string;
  level: number;
  /** Total experience points. */
  exp: number;
  nature: string;
  /** "Гены" — individual values 0..31. */
  ivs: Stats;
  /** "Раскачка" — effort values 0..252, 510 total. */
  evs: Stats;
  gender: 'M' | 'F' | null;
  shiny: boolean;
  hp: number;
  status: StatusId | null;
  sleepTurns: number;
  moves: MoveSlot[];
  ball: string;
  metAt: string;
  metLevel: number;
}

export type Stages = Record<BattleStat, number>;

export type BattleEvent =
  | { t: 'msg'; text: string }
  | { t: 'move'; side: Side; moveId: string }
  | { t: 'damage'; side: Side; amount: number; hp: number; eff: number; crit: boolean }
  | { t: 'heal'; side: Side; amount: number; hp: number }
  | { t: 'status'; side: Side; status: StatusId | null }
  | { t: 'stat'; side: Side; stat: BattleStat; delta: number }
  | { t: 'miss'; side: Side }
  | { t: 'faint'; side: Side }
  | { t: 'switch'; side: Side; uid: string }
  | { t: 'ball'; ball: string; shakes: number; caught: boolean }
  | { t: 'exp'; uid: string; amount: number }
  | { t: 'levelup'; uid: string; level: number }
  | { t: 'learn'; uid: string; moveId: string }
  | { t: 'end'; result: BattleResult };

export type Side = 'player' | 'enemy';
export type BattleResult = 'win' | 'lose' | 'caught' | 'fled';

export interface BattleState {
  kind: 'wild' | 'trainer';
  trainerId?: string;
  trainerName?: string;
  biome: Biome;
  enemyTeam: Pokemon[];
  enemyActive: number;
  /** Index into GameState.team. */
  playerActive: number;
  playerStages: Stages;
  enemyStages: Stages;
  /** uids of player pokemon that fought the current enemy. */
  participants: string[];
  /** uids of player pokemon that leveled up during this battle. */
  leveled: string[];
  turn: number;
  runAttempts: number;
  payDay: number;
  phase: 'choose' | 'forceSwitch' | 'ended';
  result: BattleResult | null;
  /** Events of the latest turn, for the UI to animate. */
  lastEvents: BattleEvent[];
  /** Monotonic counter so the UI knows a new turn happened. */
  seq: number;
}

export interface LogEntry {
  id: number;
  time: number;
  text: string;
  kind: 'info' | 'good' | 'bad' | 'rare';
}

export interface GameStats {
  encounters: number;
  wildDefeated: number;
  caught: number;
  trainersDefeated: number;
  shinySeen: number;
  itemsFound: number;
  losses: number;
}

export interface GameState {
  version: number;
  player: { name: string; money: number; badges: string[]; createdAt: number };
  location: string;
  lastPokecenter: string;
  team: Pokemon[];
  storage: Pokemon[];
  bag: Record<string, number>;
  dex: Record<number, 'seen' | 'caught'>;
  defeatedTrainers: string[];
  battle: BattleState | null;
  log: LogEntry[];
  stats: GameStats;
  pendingLearn: { uid: string; moveId: string }[];
  pendingEvolution: { uid: string; to: number }[];
  nextUid: number;
  nextLogId: number;
}

export const SAVE_VERSION = 1;
export const MAX_TEAM = 6;
