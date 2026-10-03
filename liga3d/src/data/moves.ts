import type { PokeType } from './types';

export type MoveCategory = 'physical' | 'special' | 'status';
export type StatusId = 'brn' | 'psn' | 'par' | 'slp' | 'frz';
export type BattleStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva';

export interface MoveEffect {
  /** Inflict a major status on the target. */
  status?: { id: StatusId; chance: number };
  /** Change stat stages of the user or the target. */
  stats?: { target: 'self' | 'foe'; changes: Partial<Record<BattleStat, number>>; chance: number };
  flinch?: number;
  /** Fraction of dealt damage restored to the user. */
  drain?: number;
  /** Fraction of dealt damage the user takes back. */
  recoil?: number;
  /** Fraction of max HP the user restores (status moves). */
  heal?: number;
  multiHit?: [number, number];
  fixedDamage?: number | 'level';
  highCrit?: boolean;
  neverMiss?: boolean;
  rest?: boolean;
  flee?: boolean;
  payDay?: boolean;
  /** Power doubles if the target has a major status. */
  hex?: boolean;
}

export interface MoveData {
  id: string;
  name: string;
  type: PokeType;
  category: MoveCategory;
  power: number;
  /** null = never misses */
  accuracy: number | null;
  pp: number;
  priority: number;
  effect: MoveEffect;
}

type Extra = Partial<Pick<MoveData, 'priority'>> & MoveEffect;

function m(
  id: string, name: string, type: PokeType, category: MoveCategory,
  power: number, accuracy: number | null, pp: number, extra: Extra = {},
): MoveData {
  const { priority = 0, ...effect } = extra;
  return { id, name, type, category, power, accuracy: effect.neverMiss ? null : accuracy, pp, priority, effect };
}

const brn = (chance: number) => ({ status: { id: 'brn' as const, chance } });
const psn = (chance: number) => ({ status: { id: 'psn' as const, chance } });
const par = (chance: number) => ({ status: { id: 'par' as const, chance } });
const slp = (chance: number) => ({ status: { id: 'slp' as const, chance } });
const frz = (chance: number) => ({ status: { id: 'frz' as const, chance } });
const foe = (changes: Partial<Record<BattleStat, number>>, chance = 100) => ({ stats: { target: 'foe' as const, changes, chance } });
const self = (changes: Partial<Record<BattleStat, number>>, chance = 100) => ({ stats: { target: 'self' as const, changes, chance } });

const LIST: MoveData[] = [
  // Normal
  m('tackle', 'Таран', 'normal', 'physical', 40, 100, 35),
  m('scratch', 'Царапина', 'normal', 'physical', 40, 100, 35),
  m('pound', 'Шлепок', 'normal', 'physical', 40, 100, 35),
  m('quick-attack', 'Быстрая атака', 'normal', 'physical', 40, 100, 30, { priority: 1 }),
  m('growl', 'Рык', 'normal', 'status', 0, 100, 40, foe({ atk: -1 })),
  m('tail-whip', 'Взмах хвостом', 'normal', 'status', 0, 100, 30, foe({ def: -1 })),
  m('leer', 'Злобный взгляд', 'normal', 'status', 0, 100, 30, foe({ def: -1 })),
  m('sand-attack', 'Песок в глаза', 'ground', 'status', 0, 100, 15, foe({ acc: -1 })),
  m('string-shot', 'Липкая нить', 'bug', 'status', 0, 95, 40, foe({ spe: -2 })),
  m('harden', 'Затвердение', 'normal', 'status', 0, null, 30, self({ def: 1 })),
  m('defense-curl', 'Сворачивание', 'normal', 'status', 0, null, 40, self({ def: 1 })),
  m('headbutt', 'Удар головой', 'normal', 'physical', 70, 100, 15, { flinch: 30 }),
  m('body-slam', 'Бросок телом', 'normal', 'physical', 85, 100, 15, par(30)),
  m('hyper-fang', 'Гиперклык', 'normal', 'physical', 80, 90, 15, { flinch: 10 }),
  m('slam', 'Хлёсткий удар', 'normal', 'physical', 80, 75, 20),
  m('take-down', 'Таран с разбега', 'normal', 'physical', 90, 85, 20, { recoil: 0.25 }),
  m('double-edge', 'Отчаянный рывок', 'normal', 'physical', 120, 100, 15, { recoil: 0.33 }),
  m('swift', 'Звёздочки', 'normal', 'special', 60, null, 20, { neverMiss: true }),
  m('fury-swipes', 'Яростные царапины', 'normal', 'physical', 18, 80, 15, { multiHit: [2, 5] }),
  m('sing', 'Колыбельная', 'normal', 'status', 0, 55, 15, slp(100)),
  m('rest', 'Отдых', 'psychic', 'status', 0, null, 5, { rest: true }),
  m('pay-day', 'Монетки', 'normal', 'physical', 40, 100, 20, { payDay: true }),
  m('agility', 'Ускорение', 'psychic', 'status', 0, null, 30, self({ spe: 2 })),
  m('swords-dance', 'Танец мечей', 'normal', 'status', 0, null, 20, self({ atk: 2 })),
  m('growth', 'Рост', 'normal', 'status', 0, null, 20, self({ atk: 1, spa: 1 })),
  m('recover', 'Восстановление', 'normal', 'status', 0, null, 10, { heal: 0.5 }),
  m('double-team', 'Двойник', 'normal', 'status', 0, null, 15, self({ eva: 1 })),
  m('splash', 'Плеск', 'normal', 'status', 0, null, 40),
  m('hyper-voice', 'Гиперголос', 'normal', 'special', 90, 100, 10),
  m('extreme-speed', 'Сверхскорость', 'normal', 'physical', 80, 100, 5, { priority: 2 }),
  m('wrap', 'Обвивание', 'normal', 'physical', 15, 90, 20, { multiHit: [2, 5] }),
  m('screech', 'Скрежет', 'normal', 'status', 0, 85, 40, foe({ def: -2 })),
  m('supersonic', 'Ультразвук', 'normal', 'status', 0, 55, 20, foe({ acc: -1 })),
  m('glare', 'Свирепый взгляд', 'normal', 'status', 0, 100, 30, par(100)),
  m('charm', 'Очарование', 'fairy', 'status', 0, 100, 20, foe({ atk: -2 })),

  // Fire
  m('ember', 'Угольки', 'fire', 'special', 40, 100, 25, brn(10)),
  m('flame-wheel', 'Огненное колесо', 'fire', 'physical', 60, 100, 25, brn(10)),
  m('fire-fang', 'Огненный клык', 'fire', 'physical', 65, 95, 15, { ...brn(10), flinch: 10 }),
  m('flamethrower', 'Огнемёт', 'fire', 'special', 90, 100, 15, brn(10)),
  m('fire-blast', 'Огненный взрыв', 'fire', 'special', 110, 85, 5, brn(10)),
  m('flare-blitz', 'Пламенный рывок', 'fire', 'physical', 120, 100, 15, { ...brn(10), recoil: 0.33 }),
  m('will-o-wisp', 'Блуждающий огонь', 'fire', 'status', 0, 85, 15, brn(100)),

  // Water
  m('water-gun', 'Водомёт', 'water', 'special', 40, 100, 25),
  m('bubble', 'Пузыри', 'water', 'special', 40, 100, 30, foe({ spe: -1 }, 10)),
  m('bubble-beam', 'Луч пузырей', 'water', 'special', 65, 100, 20, foe({ spe: -1 }, 10)),
  m('water-pulse', 'Водный импульс', 'water', 'special', 60, 100, 20),
  m('aqua-tail', 'Водный хвост', 'water', 'physical', 90, 90, 10),
  m('surf', 'Сёрфинг', 'water', 'special', 90, 100, 15),
  m('hydro-pump', 'Гидронасос', 'water', 'special', 110, 80, 5),
  m('waterfall', 'Водопад', 'water', 'physical', 80, 100, 15, { flinch: 20 }),
  m('withdraw', 'Укрытие в панцирь', 'water', 'status', 0, null, 40, self({ def: 1 })),

  // Grass
  m('vine-whip', 'Лозовый хлыст', 'grass', 'physical', 45, 100, 25),
  m('absorb', 'Поглощение', 'grass', 'special', 20, 100, 25, { drain: 0.5 }),
  m('mega-drain', 'Мега-поглощение', 'grass', 'special', 40, 100, 15, { drain: 0.5 }),
  m('giga-drain', 'Гига-поглощение', 'grass', 'special', 75, 100, 10, { drain: 0.5 }),
  m('razor-leaf', 'Бритвенный лист', 'grass', 'physical', 55, 95, 25, { highCrit: true }),
  m('energy-ball', 'Энергошар', 'grass', 'special', 90, 100, 10, foe({ spd: -1 }, 10)),
  m('petal-blizzard', 'Лепестковая буря', 'grass', 'physical', 90, 100, 15),
  m('sleep-powder', 'Усыпляющая пыльца', 'grass', 'status', 0, 75, 15, slp(100)),
  m('poison-powder', 'Ядовитая пыльца', 'poison', 'status', 0, 75, 35, psn(100)),
  m('stun-spore', 'Парализующие споры', 'grass', 'status', 0, 75, 30, par(100)),
  m('spore', 'Споры', 'grass', 'status', 0, 100, 15, slp(100)),

  // Electric
  m('thunder-shock', 'Электрошок', 'electric', 'special', 40, 100, 30, par(10)),
  m('spark', 'Искра', 'electric', 'physical', 65, 100, 20, par(30)),
  m('thunderbolt', 'Удар молнии', 'electric', 'special', 90, 100, 15, par(10)),
  m('thunder', 'Гром', 'electric', 'special', 110, 70, 10, par(30)),
  m('thunder-wave', 'Волна грома', 'electric', 'status', 0, 90, 20, par(100)),
  m('thunder-fang', 'Громовой клык', 'electric', 'physical', 65, 95, 15, { ...par(10), flinch: 10 }),

  // Ice
  m('powder-snow', 'Снежная пыль', 'ice', 'special', 40, 100, 25, frz(10)),
  m('ice-beam', 'Ледяной луч', 'ice', 'special', 90, 100, 10, frz(10)),
  m('ice-fang', 'Ледяной клык', 'ice', 'physical', 65, 95, 15, { ...frz(10), flinch: 10 }),

  // Fighting
  m('karate-chop', 'Удар каратэ', 'fighting', 'physical', 50, 100, 25, { highCrit: true }),
  m('low-kick', 'Подсечка', 'fighting', 'physical', 60, 100, 20),
  m('seismic-toss', 'Сейсмический бросок', 'fighting', 'physical', 0, 100, 20, { fixedDamage: 'level' }),
  m('brick-break', 'Разбивание', 'fighting', 'physical', 75, 100, 15),
  m('cross-chop', 'Перекрёстный удар', 'fighting', 'physical', 100, 80, 5, { highCrit: true }),
  m('submission', 'Покорение', 'fighting', 'physical', 80, 80, 20, { recoil: 0.25 }),
  m('close-combat', 'Ближний бой', 'fighting', 'physical', 120, 100, 5, self({ def: -1, spd: -1 })),
  m('bulk-up', 'Накачка', 'fighting', 'status', 0, null, 20, self({ atk: 1, def: 1 })),

  // Poison
  m('poison-sting', 'Ядовитое жало', 'poison', 'physical', 15, 100, 35, psn(30)),
  m('acid', 'Кислота', 'poison', 'special', 40, 100, 30, foe({ spd: -1 }, 10)),
  m('sludge', 'Нечистоты', 'poison', 'special', 65, 100, 20, psn(30)),
  m('sludge-bomb', 'Грязевая бомба', 'poison', 'special', 90, 100, 10, psn(30)),
  m('poison-fang', 'Ядовитый клык', 'poison', 'physical', 50, 100, 15, psn(50)),
  m('poison-jab', 'Ядовитый укол', 'poison', 'physical', 80, 100, 20, psn(30)),
  m('toxic', 'Токсин', 'poison', 'status', 0, 90, 10, psn(100)),

  // Ground
  m('mud-slap', 'Грязевой шлепок', 'ground', 'special', 20, 100, 10, foe({ acc: -1 })),
  m('bulldoze', 'Сотрясение', 'ground', 'physical', 60, 100, 20, foe({ spe: -1 })),
  m('dig', 'Подкоп', 'ground', 'physical', 80, 100, 10),
  m('earthquake', 'Землетрясение', 'ground', 'physical', 100, 100, 10),
  m('earth-power', 'Сила земли', 'ground', 'special', 90, 100, 10, foe({ spd: -1 }, 10)),

  // Flying
  m('gust', 'Порыв ветра', 'flying', 'special', 40, 100, 35),
  m('peck', 'Клевок', 'flying', 'physical', 35, 100, 35),
  m('wing-attack', 'Удар крылом', 'flying', 'physical', 60, 100, 35),
  m('aerial-ace', 'Воздушный удар', 'flying', 'physical', 60, null, 20, { neverMiss: true }),
  m('drill-peck', 'Буравящий клюв', 'flying', 'physical', 80, 100, 20),
  m('air-slash', 'Воздушный клинок', 'flying', 'special', 75, 95, 15, { flinch: 30 }),
  m('hurricane', 'Ураган', 'flying', 'special', 110, 70, 10),

  // Psychic
  m('confusion', 'Замешательство', 'psychic', 'special', 50, 100, 25),
  m('psybeam', 'Психолуч', 'psychic', 'special', 65, 100, 20),
  m('psychic', 'Психика', 'psychic', 'special', 90, 100, 10, foe({ spd: -1 }, 10)),
  m('hypnosis', 'Гипноз', 'psychic', 'status', 0, 60, 20, slp(100)),
  m('calm-mind', 'Спокойствие', 'psychic', 'status', 0, null, 20, self({ spa: 1, spd: 1 })),
  m('teleport', 'Телепорт', 'psychic', 'status', 0, null, 20, { flee: true }),
  m('zen-headbutt', 'Дзен-удар', 'psychic', 'physical', 80, 90, 15, { flinch: 20 }),

  // Bug
  m('bug-bite', 'Укус жука', 'bug', 'physical', 60, 100, 20),
  m('leech-life', 'Пиявка', 'bug', 'physical', 80, 100, 10, { drain: 0.5 }),
  m('x-scissor', 'Икс-ножницы', 'bug', 'physical', 80, 100, 15),
  m('signal-beam', 'Сигнальный луч', 'bug', 'special', 75, 100, 15),
  m('bug-buzz', 'Жужжание', 'bug', 'special', 90, 100, 10, foe({ spd: -1 }, 10)),
  m('twineedle', 'Двойная игла', 'bug', 'physical', 25, 100, 20, { multiHit: [2, 2], ...psn(20) }),

  // Rock
  m('rock-throw', 'Бросок камня', 'rock', 'physical', 50, 90, 15),
  m('rock-tomb', 'Каменная гробница', 'rock', 'physical', 60, 95, 15, foe({ spe: -1 })),
  m('rock-slide', 'Камнепад', 'rock', 'physical', 75, 90, 10, { flinch: 30 }),
  m('stone-edge', 'Каменное лезвие', 'rock', 'physical', 100, 80, 5, { highCrit: true }),
  m('ancient-power', 'Древняя сила', 'rock', 'special', 60, 100, 5, self({ atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, 10)),

  // Ghost
  m('lick', 'Лизание', 'ghost', 'physical', 30, 100, 30, par(30)),
  m('night-shade', 'Ночная тень', 'ghost', 'special', 0, 100, 15, { fixedDamage: 'level' }),
  m('hex', 'Порча', 'ghost', 'special', 65, 100, 10, { hex: true }),
  m('shadow-ball', 'Шар тени', 'ghost', 'special', 80, 100, 15, foe({ spd: -1 }, 20)),
  m('shadow-claw', 'Теневой коготь', 'ghost', 'physical', 70, 100, 15, { highCrit: true }),

  // Dragon
  m('twister', 'Смерч', 'dragon', 'special', 40, 100, 20, { flinch: 20 }),
  m('dragon-rage', 'Ярость дракона', 'dragon', 'special', 0, 100, 10, { fixedDamage: 40 }),
  m('dragon-breath', 'Дыхание дракона', 'dragon', 'special', 60, 100, 20, par(30)),
  m('dragon-claw', 'Драконий коготь', 'dragon', 'physical', 80, 100, 15),
  m('dragon-pulse', 'Импульс дракона', 'dragon', 'special', 85, 100, 10),
  m('dragon-dance', 'Танец дракона', 'dragon', 'status', 0, null, 20, self({ atk: 1, spe: 1 })),
  m('outrage', 'Неистовство', 'dragon', 'physical', 120, 100, 10),

  // Dark
  m('bite', 'Укус', 'dark', 'physical', 60, 100, 25, { flinch: 30 }),
  m('crunch', 'Хруст', 'dark', 'physical', 80, 100, 15, foe({ def: -1 }, 20)),
  m('feint-attack', 'Подлый удар', 'dark', 'physical', 60, null, 20, { neverMiss: true }),
  m('night-slash', 'Ночной разрез', 'dark', 'physical', 70, 100, 15, { highCrit: true }),
  m('dark-pulse', 'Тёмный импульс', 'dark', 'special', 80, 100, 15, { flinch: 20 }),

  // Steel
  m('metal-claw', 'Стальной коготь', 'steel', 'physical', 50, 95, 35, self({ atk: 1 }, 10)),
  m('iron-tail', 'Железный хвост', 'steel', 'physical', 100, 75, 15, foe({ def: -1 }, 30)),
  m('flash-cannon', 'Луч вспышки', 'steel', 'special', 80, 100, 10, foe({ spd: -1 }, 10)),
  m('iron-defense', 'Железная защита', 'steel', 'status', 0, null, 15, self({ def: 2 })),
  m('magnet-bomb', 'Магнитная бомба', 'steel', 'physical', 60, null, 20, { neverMiss: true }),

  // Fairy
  m('fairy-wind', 'Волшебный ветер', 'fairy', 'special', 40, 100, 30),
  m('disarming-voice', 'Обезоруживающий голос', 'fairy', 'special', 40, null, 15, { neverMiss: true }),
  m('draining-kiss', 'Осушающий поцелуй', 'fairy', 'special', 50, 100, 10, { drain: 0.75 }),
  m('moonblast', 'Лунный удар', 'fairy', 'special', 95, 100, 15, foe({ spa: -1 }, 30)),
  m('play-rough', 'Грубая игра', 'fairy', 'physical', 90, 90, 10, foe({ atk: -1 }, 10)),

  // Used when no PP is left
  m('struggle', 'Борьба', 'normal', 'physical', 50, null, 1, { neverMiss: true, recoil: 0.25 }),
];

export const MOVES: Record<string, MoveData> = Object.fromEntries(LIST.map((mv) => [mv.id, mv]));

export function getMove(id: string): MoveData {
  const mv = MOVES[id];
  if (!mv) throw new Error(`Unknown move: ${id}`);
  return mv;
}

export const STAT_NAMES: Record<BattleStat, string> = {
  atk: 'Атака', def: 'Защита', spa: 'Спец. атака', spd: 'Спец. защита', spe: 'Скорость', acc: 'Точность', eva: 'Уклонение',
};

export const STATUS_INFO: Record<StatusId, { name: string; short: string; color: string }> = {
  brn: { name: 'Ожог', short: 'ОЖГ', color: '#ee8130' },
  psn: { name: 'Отравление', short: 'ЯД', color: '#a33ea1' },
  par: { name: 'Паралич', short: 'ПАР', color: '#d4b000' },
  slp: { name: 'Сон', short: 'СОН', color: '#7f8c9a' },
  frz: { name: 'Заморозка', short: 'ЛЁД', color: '#5fc6d6' },
};
