import { SPECIES } from '../data/species';
import { LOCATIONS } from '../data/world';
import type { GameState } from './model';
import { SAVE_VERSION } from './model';

export const SAVE_KEY = 'liga3d-save';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string): GameState {
  const data = JSON.parse(json) as GameState;
  if (!data || typeof data !== 'object') throw new Error('Повреждённое сохранение');
  if (data.version !== SAVE_VERSION) throw new Error(`Неподдерживаемая версия сохранения: ${data.version}`);
  if (!Array.isArray(data.team) || !Array.isArray(data.storage) || !data.player) throw new Error('Повреждённое сохранение');
  if (!LOCATIONS[data.location]) throw new Error('Сохранение ссылается на неизвестную локацию');
  for (const p of [...data.team, ...data.storage]) {
    if (!SPECIES[p.species]) throw new Error('Сохранение содержит неизвестного покемона');
  }
  return data;
}

export function loadFromStorage(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? deserialize(raw) : null;
  } catch {
    return null;
  }
}

export function saveToStorage(state: GameState): boolean {
  try {
    localStorage.setItem(SAVE_KEY, serialize(state));
    return true;
  } catch {
    return false;
  }
}

export function clearStorage(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}
