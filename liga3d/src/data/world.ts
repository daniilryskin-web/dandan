export type Biome = 'town' | 'meadow' | 'forest' | 'mountain' | 'cave' | 'lake' | 'volcano' | 'plant' | 'hills';

export interface Encounter {
  species: number;
  min: number;
  max: number;
  weight: number;
}

export interface TrainerMon {
  species: number;
  level: number;
}

export interface TrainerDef {
  id: string;
  name: string;
  title: string;
  team: TrainerMon[];
  reward: number;
  intro: string;
  defeat: string;
  badge?: string;
}

export interface LocationData {
  id: string;
  name: string;
  biome: Biome;
  description: string;
  exits: string[];
  pos: [number, number];
  pokecenter?: boolean;
  shop?: string[];
  wild?: Encounter[];
  fishing?: { old: Encounter[]; good: Encounter[] };
  loot?: { item: string; weight: number }[];
  trainers?: TrainerDef[];
  gym?: TrainerDef;
  requiresBadge?: string;
}

export const BADGES: Record<string, { name: string; color: string }> = {
  stone: { name: 'Каменный значок', color: '#9e9e9e' },
  flame: { name: 'Огненный значок', color: '#ff7043' },
};

const e = (species: number, min: number, max: number, weight: number): Encounter => ({ species, min, max, weight });

const LIST: LocationData[] = [
  {
    id: 'dawn-village', name: 'Деревня Рассвета', biome: 'town', pos: [8, 78],
    description: 'Тихая деревня, где начинается путь каждого тренера. Здесь есть покецентр и небольшая лавка.',
    exits: ['meadow-route'], pokecenter: true,
    shop: ['poke-ball', 'potion', 'antidote', 'paralyze-heal', 'awakening'],
  },
  {
    id: 'meadow-route', name: 'Луговая тропа', biome: 'meadow', pos: [22, 66],
    description: 'Широкий луг с высокой травой. Здесь обитают самые распространённые покемоны региона.',
    exits: ['dawn-village', 'emerald-forest', 'mirror-lake'],
    wild: [e(16, 2, 5, 30), e(19, 2, 5, 30), e(10, 3, 5, 12), e(13, 3, 5, 12), e(21, 3, 5, 10), e(25, 3, 5, 4), e(133, 4, 5, 2)],
    loot: [{ item: 'potion', weight: 5 }, { item: 'poke-ball', weight: 5 }, { item: 'antidote', weight: 2 }],
    trainers: [
      { id: 'misha', name: 'Миша', title: 'Юный тренер', team: [{ species: 19, level: 4 }, { species: 16, level: 5 }], reward: 160,
        intro: 'Эй! Ты тоже тренер? Давай сразимся!', defeat: 'Ух ты, ты сильный! Буду тренироваться больше.' },
    ],
  },
  {
    id: 'mirror-lake', name: 'Зеркальное озеро', biome: 'lake', pos: [34, 84],
    description: 'Спокойное озеро с прозрачной водой. С удочкой здесь можно поймать водных покемонов.',
    exits: ['meadow-route'],
    wild: [e(54, 5, 9, 30), e(60, 5, 9, 30), e(16, 5, 8, 15), e(43, 5, 8, 15), e(7, 5, 7, 3)],
    fishing: {
      old: [e(129, 5, 10, 70), e(60, 6, 10, 30)],
      good: [e(129, 10, 20, 40), e(60, 12, 18, 25), e(54, 12, 18, 20), e(147, 12, 18, 8), e(130, 20, 25, 3)],
    },
    loot: [{ item: 'super-potion', weight: 2 }, { item: 'poke-ball', weight: 4 }, { item: 'water-stone', weight: 1 }],
    trainers: [
      { id: 'oleg', name: 'Олег', title: 'Рыбак', team: [{ species: 129, level: 8 }, { species: 129, level: 9 }, { species: 60, level: 10 }], reward: 320,
        intro: 'Тсс! Распугаешь всю рыбу... Ладно, сразимся!', defeat: 'Клюёт сегодня плохо, и бой тоже не задался.' },
    ],
  },
  {
    id: 'emerald-forest', name: 'Изумрудный лес', biome: 'forest', pos: [38, 56],
    description: 'Густой лес, полный насекомых. Говорят, в глубине иногда встречаются редкие травяные покемоны.',
    exits: ['meadow-route', 'stonegrad'],
    wild: [e(10, 4, 7, 20), e(11, 6, 8, 12), e(13, 4, 7, 20), e(14, 6, 8, 12), e(43, 5, 8, 12), e(46, 5, 8, 12), e(25, 5, 8, 6), e(1, 5, 7, 2), e(17, 9, 11, 4)],
    loot: [{ item: 'potion', weight: 4 }, { item: 'antidote', weight: 3 }, { item: 'leaf-stone', weight: 1 }, { item: 'great-ball', weight: 1 }],
    trainers: [
      { id: 'petya', name: 'Петя', title: 'Жуколов', team: [{ species: 10, level: 6 }, { species: 13, level: 6 }, { species: 11, level: 7 }], reward: 210,
        intro: 'Мои жуки — лучшие в лесу! Проверим?', defeat: 'Мои жучки... Ты выиграл честно.' },
      { id: 'vanya', name: 'Ваня', title: 'Жуколов', team: [{ species: 14, level: 8 }, { species: 46, level: 9 }], reward: 270,
        intro: 'Ты прошёл Петю? Со мной так просто не будет!', defeat: 'Эх, надо было ловить побольше Парасов.' },
    ],
  },
  {
    id: 'stonegrad', name: 'Город Камнеград', biome: 'town', pos: [54, 46],
    description: 'Крупный город у подножия гор. Здесь находится стадион лидера Бориса, мастера каменных покемонов.',
    exits: ['emerald-forest', 'rocky-pass', 'quiet-hills', 'old-plant'], pokecenter: true,
    shop: ['poke-ball', 'great-ball', 'potion', 'super-potion', 'antidote', 'paralyze-heal', 'awakening', 'burn-heal', 'ice-heal', 'revive', 'old-rod'],
    gym: {
      id: 'gym-boris', name: 'Борис', title: 'Лидер стадиона', badge: 'stone', reward: 1400,
      team: [{ species: 74, level: 12 }, { species: 95, level: 14 }],
      intro: 'Камень не дрогнет ни перед ветром, ни перед водой. А перед тобой?', defeat: 'Ты сокрушил мою каменную защиту! Держи Каменный значок.',
    },
  },
  {
    id: 'rocky-pass', name: 'Каменистый перевал', biome: 'mountain', pos: [64, 30], requiresBadge: 'stone',
    description: 'Крутая горная тропа. Без Каменного значка сюда не пускают.',
    exits: ['stonegrad', 'moon-cave'],
    wild: [e(74, 10, 14, 25), e(27, 10, 14, 20), e(21, 11, 14, 15), e(56, 11, 14, 15), e(23, 11, 14, 12), e(66, 11, 14, 10), e(95, 13, 16, 3)],
    loot: [{ item: 'super-potion', weight: 3 }, { item: 'great-ball', weight: 3 }, { item: 'ether', weight: 1 }, { item: 'revive', weight: 1 }],
    trainers: [
      { id: 'gena', name: 'Гена', title: 'Турист', team: [{ species: 74, level: 12 }, { species: 66, level: 13 }], reward: 400,
        intro: 'Горы закаляют характер! Сразимся?', defeat: 'Ну и подъём... и ну и бой!' },
      { id: 'roma', name: 'Рома', title: 'Каратист', team: [{ species: 56, level: 13 }, { species: 66, level: 14 }], reward: 450,
        intro: 'Ки-я! Мои кулаки не знают пощады!', defeat: 'Хм. Надо больше медитировать.' },
    ],
  },
  {
    id: 'moon-cave', name: 'Лунная пещера', biome: 'cave', pos: [84, 42],
    description: 'Тёмная пещера, в которой, по слухам, упал метеорит. Здесь водятся Клефэйри.',
    exits: ['rocky-pass', 'ember-plateau'],
    wild: [e(41, 12, 16, 35), e(74, 12, 16, 20), e(46, 13, 16, 15), e(50, 13, 17, 12), e(35, 13, 16, 8), e(92, 14, 17, 6), e(95, 15, 18, 4)],
    loot: [{ item: 'moon-stone', weight: 2 }, { item: 'super-potion', weight: 3 }, { item: 'dusk-ball', weight: 2 }, { item: 'ether', weight: 1 }],
    trainers: [
      { id: 'lev', name: 'Лев', title: 'Учёный', team: [{ species: 81, level: 15 }, { species: 35, level: 16 }], reward: 600,
        intro: 'Я изучаю лунные камни. Не мешай... впрочем, давай бой!', defeat: 'Удивительно! Твои покемоны прекрасно натренированы.' },
    ],
  },
  {
    id: 'quiet-hills', name: 'Тихие холмы', biome: 'hills', pos: [32, 28],
    description: 'Пологие холмы с цветами. Иногда здесь дремлет огромный Снорлакс.',
    exits: ['stonegrad'],
    wild: [e(39, 10, 15, 20), e(52, 10, 15, 20), e(17, 12, 16, 15), e(63, 10, 14, 10), e(19, 10, 14, 15), e(35, 11, 14, 5), e(133, 12, 15, 4), e(143, 30, 30, 1)],
    loot: [{ item: 'moon-stone', weight: 1 }, { item: 'super-potion', weight: 3 }, { item: 'awakening', weight: 3 }, { item: 'quick-ball', weight: 1 }],
    trainers: [
      { id: 'alina', name: 'Алина', title: 'Певица', team: [{ species: 39, level: 14 }, { species: 35, level: 15 }], reward: 520,
        intro: 'Послушай мою песню... а потом сразимся!', defeat: 'Браво! Ты победил под аплодисменты.' },
    ],
  },
  {
    id: 'old-plant', name: 'Старая электростанция', biome: 'plant', pos: [72, 62],
    description: 'Заброшенная электростанция, где до сих пор потрескивает ток. Здесь обитают электрические и призрачные покемоны.',
    exits: ['stonegrad'],
    wild: [e(81, 14, 18, 30), e(25, 14, 18, 20), e(92, 14, 18, 25), e(93, 20, 22, 5), e(41, 14, 17, 15)],
    loot: [{ item: 'thunder-stone', weight: 2 }, { item: 'paralyze-heal', weight: 3 }, { item: 'hyper-potion', weight: 1 }, { item: 'ultra-ball', weight: 1 }],
    trainers: [
      { id: 'stas', name: 'Стас', title: 'Инженер', team: [{ species: 81, level: 16 }, { species: 81, level: 17 }, { species: 25, level: 18 }], reward: 700,
        intro: 'Здесь всё под напряжением. И я тоже!', defeat: 'Короткое замыкание... Моя команда разряжена.' },
    ],
  },
  {
    id: 'ember-plateau', name: 'Огненное плато', biome: 'volcano', pos: [90, 24],
    description: 'Раскалённое плато у спящего вулкана. Здесь обитают огненные покемоны.',
    exits: ['moon-cave', 'ash-town'],
    wild: [e(77, 18, 23, 25), e(37, 18, 22, 20), e(58, 18, 22, 20), e(74, 18, 22, 14), e(66, 18, 22, 10), e(24, 22, 25, 8), e(4, 18, 20, 3)],
    loot: [{ item: 'fire-stone', weight: 2 }, { item: 'burn-heal', weight: 3 }, { item: 'hyper-potion', weight: 2 }, { item: 'revive', weight: 1 }],
    trainers: [
      { id: 'artem', name: 'Артём', title: 'Огнеборец', team: [{ species: 58, level: 20 }, { species: 77, level: 21 }, { species: 37, level: 21 }], reward: 900,
        intro: 'Жарко? Будет ещё жарче!', defeat: 'Пламя угасло... но я разожгу его снова.' },
    ],
  },
  {
    id: 'ash-town', name: 'Пепельный посёлок', biome: 'town', pos: [78, 10],
    description: 'Посёлок на склоне вулкана. Лидер Вера тренирует огненных покемонов.',
    exits: ['ember-plateau', 'dragon-ridge'], pokecenter: true,
    shop: ['poke-ball', 'great-ball', 'ultra-ball', 'net-ball', 'dusk-ball', 'quick-ball', 'super-potion', 'hyper-potion', 'max-potion', 'full-heal', 'revive', 'ether',
      'fire-stone', 'water-stone', 'thunder-stone', 'leaf-stone', 'moon-stone', 'good-rod'],
    gym: {
      id: 'gym-vera', name: 'Вера', title: 'Лидер стадиона', badge: 'flame', reward: 3000,
      team: [{ species: 37, level: 24 }, { species: 58, level: 25 }, { species: 78, level: 27 }],
      intro: 'Мой огонь горит ярче вулкана. Сможешь его потушить?', defeat: 'Невероятно... Ты достоин Огненного значка!',
    },
  },
  {
    id: 'dragon-ridge', name: 'Драконий хребет', biome: 'mountain', pos: [48, 8], requiresBadge: 'flame',
    description: 'Легендарный хребет, где живут драконы. Пускают только обладателей Огненного значка.',
    exits: ['ash-town'],
    wild: [e(147, 25, 30, 15), e(148, 32, 36, 5), e(95, 28, 33, 15), e(75, 28, 33, 20), e(42, 28, 33, 20), e(67, 28, 33, 13), e(22, 28, 33, 12)],
    loot: [{ item: 'ultra-ball', weight: 3 }, { item: 'max-potion', weight: 2 }, { item: 'revive', weight: 2 }, { item: 'master-ball', weight: 0.2 }],
    trainers: [
      { id: 'yan', name: 'Ян', title: 'Драконоборец', team: [{ species: 148, level: 36 }, { species: 130, level: 36 }, { species: 42, level: 35 }], reward: 2500,
        intro: 'Только сильнейшие достойны ступить на хребет. Докажи!', defeat: 'Ты... настоящий мастер. Драконы признали тебя.' },
    ],
  },
];

export const LOCATIONS: Record<string, LocationData> = Object.fromEntries(LIST.map((l) => [l.id, l]));
export const LOCATION_LIST = LIST;
export const START_LOCATION = 'dawn-village';

export function getLocation(id: string): LocationData {
  const l = LOCATIONS[id];
  if (!l) throw new Error(`Unknown location: ${id}`);
  return l;
}

export const BIOME_LABELS: Record<Biome, string> = {
  town: 'Поселение',
  meadow: 'Луг',
  forest: 'Лес',
  mountain: 'Горы',
  cave: 'Пещера',
  lake: 'Озеро',
  volcano: 'Вулкан',
  plant: 'Электростанция',
  hills: 'Холмы',
};
