export const TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice',
  'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug',
  'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
] as const;

export type PokeType = (typeof TYPES)[number];

export const TYPE_INFO: Record<PokeType, { name: string; color: string }> = {
  normal: { name: 'Нормальный', color: '#a8a77a' },
  fire: { name: 'Огненный', color: '#ee8130' },
  water: { name: 'Водный', color: '#6390f0' },
  electric: { name: 'Электрический', color: '#f7d02c' },
  grass: { name: 'Травяной', color: '#7ac74c' },
  ice: { name: 'Ледяной', color: '#96d9d6' },
  fighting: { name: 'Боевой', color: '#c22e28' },
  poison: { name: 'Ядовитый', color: '#a33ea1' },
  ground: { name: 'Земляной', color: '#e2bf65' },
  flying: { name: 'Летающий', color: '#a98ff3' },
  psychic: { name: 'Психический', color: '#f95587' },
  bug: { name: 'Насекомое', color: '#a6b91a' },
  rock: { name: 'Каменный', color: '#b6a136' },
  ghost: { name: 'Призрак', color: '#735797' },
  dragon: { name: 'Дракон', color: '#6f35fc' },
  dark: { name: 'Тёмный', color: '#705746' },
  steel: { name: 'Стальной', color: '#b7b7ce' },
  fairy: { name: 'Волшебный', color: '#d685ad' },
};

// Attacking type -> defending types it is strong (2), weak (0.5) or useless (0) against.
const CHART: Record<PokeType, { x2?: PokeType[]; half?: PokeType[]; zero?: PokeType[] }> = {
  normal: { half: ['rock', 'steel'], zero: ['ghost'] },
  fire: { x2: ['grass', 'ice', 'bug', 'steel'], half: ['fire', 'water', 'rock', 'dragon'] },
  water: { x2: ['fire', 'ground', 'rock'], half: ['water', 'grass', 'dragon'] },
  electric: { x2: ['water', 'flying'], half: ['electric', 'grass', 'dragon'], zero: ['ground'] },
  grass: { x2: ['water', 'ground', 'rock'], half: ['fire', 'grass', 'poison', 'flying', 'bug', 'dragon', 'steel'] },
  ice: { x2: ['grass', 'ground', 'flying', 'dragon'], half: ['fire', 'water', 'ice', 'steel'] },
  fighting: { x2: ['normal', 'ice', 'rock', 'dark', 'steel'], half: ['poison', 'flying', 'psychic', 'bug', 'fairy'], zero: ['ghost'] },
  poison: { x2: ['grass', 'fairy'], half: ['poison', 'ground', 'rock', 'ghost'], zero: ['steel'] },
  ground: { x2: ['fire', 'electric', 'poison', 'rock', 'steel'], half: ['grass', 'bug'], zero: ['flying'] },
  flying: { x2: ['grass', 'fighting', 'bug'], half: ['electric', 'rock', 'steel'] },
  psychic: { x2: ['fighting', 'poison'], half: ['psychic', 'steel'], zero: ['dark'] },
  bug: { x2: ['grass', 'psychic', 'dark'], half: ['fire', 'fighting', 'poison', 'flying', 'ghost', 'steel', 'fairy'] },
  rock: { x2: ['fire', 'ice', 'flying', 'bug'], half: ['fighting', 'ground', 'steel'] },
  ghost: { x2: ['psychic', 'ghost'], half: ['dark'], zero: ['normal'] },
  dragon: { x2: ['dragon'], half: ['steel'], zero: ['fairy'] },
  dark: { x2: ['psychic', 'ghost'], half: ['fighting', 'dark', 'fairy'] },
  steel: { x2: ['ice', 'rock', 'fairy'], half: ['fire', 'water', 'electric', 'steel'] },
  fairy: { x2: ['fighting', 'dragon', 'dark'], half: ['fire', 'poison', 'steel'] },
};

export function typeMultiplier(attack: PokeType, defend: PokeType): number {
  const row = CHART[attack];
  if (row.zero?.includes(defend)) return 0;
  if (row.x2?.includes(defend)) return 2;
  if (row.half?.includes(defend)) return 0.5;
  return 1;
}

export function effectiveness(attack: PokeType, defenders: readonly PokeType[]): number {
  return defenders.reduce((m, d) => m * typeMultiplier(attack, d), 1);
}

export function effectivenessLabel(mult: number): string | null {
  if (mult === 0) return 'Не действует';
  if (mult >= 4) return 'Сокрушительно ×4';
  if (mult >= 2) return 'Эффективно ×2';
  if (mult <= 0.25) return 'Почти без эффекта ×¼';
  if (mult < 1) return 'Слабо ×½';
  return null;
}
