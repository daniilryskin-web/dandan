import type { StatKey } from './species';

export interface Nature {
  id: string;
  name: string;
  up: StatKey | null;
  down: StatKey | null;
}

function n(id: string, name: string, up: StatKey | null = null, down: StatKey | null = null): Nature {
  return { id, name, up, down };
}

export const NATURES: Nature[] = [
  n('hardy', 'Выносливый'),
  n('lonely', 'Одинокий', 'atk', 'def'),
  n('brave', 'Смелый', 'atk', 'spe'),
  n('adamant', 'Непреклонный', 'atk', 'spa'),
  n('naughty', 'Непослушный', 'atk', 'spd'),
  n('bold', 'Наглый', 'def', 'atk'),
  n('docile', 'Послушный'),
  n('relaxed', 'Расслабленный', 'def', 'spe'),
  n('impish', 'Озорной', 'def', 'spa'),
  n('lax', 'Распущенный', 'def', 'spd'),
  n('timid', 'Робкий', 'spe', 'atk'),
  n('hasty', 'Поспешный', 'spe', 'def'),
  n('serious', 'Серьёзный'),
  n('jolly', 'Весёлый', 'spe', 'spa'),
  n('naive', 'Наивный', 'spe', 'spd'),
  n('modest', 'Скромный', 'spa', 'atk'),
  n('mild', 'Мягкий', 'spa', 'def'),
  n('quiet', 'Спокойный', 'spa', 'spe'),
  n('bashful', 'Застенчивый'),
  n('rash', 'Нахальный', 'spa', 'spd'),
  n('calm', 'Мирный', 'spd', 'atk'),
  n('gentle', 'Нежный', 'spd', 'def'),
  n('sassy', 'Дерзкий', 'spd', 'spe'),
  n('careful', 'Осторожный', 'spd', 'spa'),
  n('quirky', 'Причудливый'),
];

export const NATURE_BY_ID: Record<string, Nature> = Object.fromEntries(NATURES.map((x) => [x.id, x]));

export function natureMultiplier(natureId: string, stat: StatKey): number {
  const nat = NATURE_BY_ID[natureId];
  if (!nat) return 1;
  if (nat.up === stat) return 1.1;
  if (nat.down === stat) return 0.9;
  return 1;
}
