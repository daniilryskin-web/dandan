import { START_LOCATION } from '../data/world';
import type { GameState, LogEntry } from './model';
import { SAVE_VERSION } from './model';

export function newUid(state: GameState): string {
  const uid = `p${state.nextUid}`;
  state.nextUid += 1;
  return uid;
}

export function addLog(state: GameState, text: string, kind: LogEntry['kind'] = 'info'): void {
  state.log.unshift({ id: state.nextLogId++, time: Date.now(), text, kind });
  if (state.log.length > 120) state.log.length = 120;
}

export function markSeen(state: GameState, speciesId: number): void {
  if (!state.dex[speciesId]) state.dex[speciesId] = 'seen';
}

export function emptyState(name: string): GameState {
  return {
    version: SAVE_VERSION,
    player: { name, money: 3000, badges: [], createdAt: Date.now() },
    location: START_LOCATION,
    lastPokecenter: START_LOCATION,
    team: [],
    storage: [],
    bag: { 'poke-ball': 10, potion: 3 },
    dex: {},
    defeatedTrainers: [],
    battle: null,
    log: [],
    stats: { encounters: 0, wildDefeated: 0, caught: 0, trainersDefeated: 0, shinySeen: 0, itemsFound: 0, losses: 0 },
    pendingLearn: [],
    pendingEvolution: [],
    nextUid: 1,
    nextLogId: 1,
  };
}
