import type { PokeType } from './types';
import { MOVES } from './moves';

export type GrowthRate = 'fast' | 'mediumFast' | 'mediumSlow' | 'slow';
export type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type Stats = Record<StatKey, number>;
export const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_LABELS: Record<StatKey, string> = {
  hp: 'HP', atk: 'Атака', def: 'Защита', spa: 'Сп. атака', spd: 'Сп. защита', spe: 'Скорость',
};

export type BodyShape = 'quad' | 'biped' | 'bird' | 'fish' | 'serpent' | 'blob' | 'larva';

/** Parameters for the procedural low-poly 3D model. */
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
}

export interface Species {
  id: number;
  name: string;
  /** English name, used to match images from a local sprite archive. */
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
  /** Evolution stage, 1..3 (used for EV yield). */
  stage: number;
}

type Raw = {
  id: number;
  name: string;
  types: PokeType[];
  base: [number, number, number, number, number, number];
  catch: number;
  exp: number;
  growth: GrowthRate;
  male?: number | null;
  evo?: Evolution[];
  moves: string;
  look: Look;
  stage?: number;
};

function parseLearnset(spec: string): [number, string][] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [lvl, move] = s.split(/\s+/);
      if (!MOVES[move]) throw new Error(`Unknown move in learnset: ${move}`);
      return [Number(lvl), move] as [number, string];
    })
    .sort((a, b) => a[0] - b[0]);
}

// Family learnsets (shared by all stages of a family). Format: "level move, level move".
const L: Record<string, string> = {
  bulba: '1 tackle,3 growl,7 vine-whip,10 poison-powder,13 sleep-powder,15 take-down,19 razor-leaf,24 growth,28 mega-drain,32 giga-drain,37 double-edge,42 energy-ball,48 petal-blizzard',
  charm: '1 scratch,1 growl,7 ember,10 leer,13 dragon-rage,17 metal-claw,21 fire-fang,25 flame-wheel,28 night-slash,32 flamethrower,40 dragon-claw,46 fire-blast,52 flare-blitz',
  squirt: '1 tackle,3 tail-whip,7 water-gun,10 withdraw,13 bubble,16 bite,19 water-pulse,23 bubble-beam,28 aqua-tail,31 iron-defense,36 surf,41 crunch,46 hydro-pump',
  paras: '1 scratch,6 stun-spore,6 poison-powder,11 absorb,17 fury-swipes,22 spore,27 bug-bite,33 growth,38 giga-drain',
  pidgey: '1 tackle,5 sand-attack,9 gust,13 quick-attack,17 twister,21 wing-attack,25 agility,29 aerial-ace,33 air-slash,39 double-edge',
  rattata: '1 tackle,1 tail-whip,4 quick-attack,10 bite,13 feint-attack,16 hyper-fang,22 crunch,25 take-down,28 swords-dance,31 double-edge',
  spearow: '1 peck,1 growl,5 leer,9 fury-swipes,13 aerial-ace,19 agility,23 wing-attack,27 take-down,36 double-edge',
  meowth: '1 scratch,1 growl,6 bite,9 quick-attack,14 fury-swipes,17 screech,22 feint-attack,25 pay-day,30 night-slash,36 swift,42 swords-dance',
  jiggly: '1 sing,1 pound,5 defense-curl,9 disarming-voice,13 rest,17 body-slam,21 draining-kiss,25 hyper-voice,30 double-edge,35 play-rough',
  eevee: '1 tackle,1 tail-whip,5 sand-attack,10 quick-attack,13 bite,17 swift,20 headbutt,25 take-down,29 charm,33 double-edge',
  pika: '1 thunder-shock,1 growl,5 tail-whip,8 thunder-wave,10 quick-attack,13 double-team,18 spark,23 feint-attack,26 slam,29 thunderbolt,34 iron-tail,37 agility,42 thunder',
  magne: '1 tackle,1 supersonic,5 thunder-shock,7 thunder-wave,11 swift,13 spark,17 magnet-bomb,23 screech,29 thunderbolt,33 iron-defense',
  ekans: '1 wrap,1 leer,4 poison-sting,9 bite,12 glare,17 screech,20 acid,25 sludge,33 poison-jab,38 sludge-bomb',
  zubat: '1 absorb,4 supersonic,8 bite,12 wing-attack,16 poison-fang,20 air-slash,24 leech-life,30 crunch,35 sludge-bomb',
  oddish: '1 absorb,5 growth,9 acid,12 poison-powder,14 stun-spore,16 sleep-powder,19 mega-drain,24 sludge,29 giga-drain,34 moonblast,39 energy-ball',
  sand: '1 scratch,1 defense-curl,3 sand-attack,5 poison-sting,9 rock-throw,13 fury-swipes,17 bulldoze,20 metal-claw,24 night-slash,28 dig,33 rock-slide,37 iron-defense,42 earthquake',
  diglett: '1 scratch,1 sand-attack,4 growl,8 mud-slap,12 bulldoze,18 feint-attack,23 dig,29 night-slash,33 earth-power,40 earthquake',
  clef: '1 pound,1 growl,4 defense-curl,7 sing,10 disarming-voice,13 fairy-wind,19 draining-kiss,22 rest,26 body-slam,31 moonblast,36 calm-mind',
  vulpix: '1 ember,4 tail-whip,7 quick-attack,9 will-o-wisp,12 hex,15 flame-wheel,18 feint-attack,23 fire-fang,28 flamethrower,34 dark-pulse,40 fire-blast',
  growl: '1 bite,1 ember,8 leer,12 quick-attack,17 flame-wheel,21 fire-fang,25 take-down,30 flamethrower,34 agility,39 crunch,45 flare-blitz',
  ponyta: '1 tackle,1 growl,4 tail-whip,9 ember,13 flame-wheel,17 headbutt,21 fire-fang,25 take-down,29 agility,33 flamethrower,37 flare-blitz,43 fire-blast',
  psyduck: '1 scratch,1 water-gun,4 tail-whip,11 confusion,15 fury-swipes,18 water-pulse,22 screech,25 zen-headbutt,29 aqua-tail,33 surf,37 psychic',
  poli: '1 water-gun,5 bubble,8 hypnosis,15 pound,21 body-slam,25 bubble-beam,28 mud-slap,35 hydro-pump,38 earth-power',
  kadabra: '1 teleport,16 confusion,21 psybeam,25 calm-mind,28 recover,33 psychic,40 dark-pulse',
  mankey: '1 scratch,1 leer,1 low-kick,5 fury-swipes,8 karate-chop,12 seismic-toss,17 swift,22 bulk-up,26 cross-chop,30 screech,36 close-combat',
  machop: '1 low-kick,1 leer,7 karate-chop,10 seismic-toss,15 brick-break,19 submission,22 bulk-up,31 cross-chop,37 rock-slide,43 close-combat',
  geo: '1 tackle,1 defense-curl,4 mud-slap,10 rock-throw,13 bulldoze,16 rock-tomb,22 rock-slide,28 iron-defense,30 dig,35 earthquake,40 stone-edge,46 double-edge',
  gastly: '1 lick,1 hypnosis,8 night-shade,15 hex,22 sludge,29 shadow-ball,33 sludge-bomb,38 dark-pulse',
  dratini: '1 wrap,1 leer,5 thunder-wave,11 twister,15 dragon-rage,21 slam,25 agility,31 dragon-breath,35 aqua-tail,41 dragon-pulse,45 dragon-dance,51 outrage',
};

const RAW: Raw[] = [
  // ——— Starters ———
  { id: 1, name: 'Бульбазавр', types: ['grass', 'poison'], base: [45, 49, 49, 65, 65, 45], catch: 45, exp: 64, growth: 'mediumSlow', male: 0.875,
    evo: [{ to: 2, level: 16 }], moves: L.bulba,
    look: { shape: 'quad', color: '#5fbf9f', accent: '#3f8f63', belly: '#8fd9be', bulb: 'bud', ears: 'pointy', size: 0.75 } },
  { id: 2, name: 'Ивизавр', types: ['grass', 'poison'], base: [60, 62, 63, 80, 80, 60], catch: 45, exp: 142, growth: 'mediumSlow', male: 0.875, stage: 2,
    evo: [{ to: 3, level: 32 }], moves: L.bulba,
    look: { shape: 'quad', color: '#4fae9a', accent: '#2f7f4f', belly: '#8fd9be', bulb: 'flower', ears: 'pointy', size: 0.95 } },
  { id: 3, name: 'Венузавр', types: ['grass', 'poison'], base: [80, 82, 83, 100, 100, 80], catch: 45, exp: 236, growth: 'mediumSlow', male: 0.875, stage: 3,
    moves: L.bulba + ',50 earthquake',
    look: { shape: 'quad', color: '#3f9f8f', accent: '#2f6f3f', belly: '#7fc9ae', bulb: 'flower', ears: 'pointy', size: 1.3 } },
  { id: 4, name: 'Чармандер', types: ['fire'], base: [39, 52, 43, 60, 50, 65], catch: 45, exp: 62, growth: 'mediumSlow', male: 0.875,
    evo: [{ to: 5, level: 16 }], moves: L.charm,
    look: { shape: 'biped', color: '#f28c38', accent: '#ffcf4a', belly: '#ffe39a', tail: 'flame', size: 0.7 } },
  { id: 5, name: 'Чармелеон', types: ['fire'], base: [58, 64, 58, 80, 65, 80], catch: 45, exp: 142, growth: 'mediumSlow', male: 0.875, stage: 2,
    evo: [{ to: 6, level: 36 }], moves: L.charm,
    look: { shape: 'biped', color: '#e0503a', accent: '#ffcf4a', belly: '#f6d59a', tail: 'flame', horns: 1, size: 0.95 } },
  { id: 6, name: 'Чаризард', types: ['fire', 'flying'], base: [78, 84, 78, 109, 85, 100], catch: 45, exp: 240, growth: 'mediumSlow', male: 0.875, stage: 3,
    moves: L.charm + ',36 air-slash,55 hurricane',
    look: { shape: 'biped', color: '#f07a2c', accent: '#2f7a8f', belly: '#ffe39a', tail: 'flame', wings: 'bat', horns: 2, size: 1.35 } },
  { id: 7, name: 'Сквиртл', types: ['water'], base: [44, 48, 65, 50, 64, 43], catch: 45, exp: 63, growth: 'mediumSlow', male: 0.875,
    evo: [{ to: 8, level: 16 }], moves: L.squirt,
    look: { shape: 'biped', color: '#7cc6e8', accent: '#a0662f', belly: '#f1e3a2', shell: true, tail: 'curl', size: 0.7 } },
  { id: 8, name: 'Вартортл', types: ['water'], base: [59, 63, 80, 65, 80, 58], catch: 45, exp: 142, growth: 'mediumSlow', male: 0.875, stage: 2,
    evo: [{ to: 9, level: 36 }], moves: L.squirt,
    look: { shape: 'biped', color: '#7fa9e8', accent: '#8a552a', belly: '#f1e3a2', shell: true, tail: 'fluffy', ears: 'fin', size: 0.95 } },
  { id: 9, name: 'Бластойз', types: ['water'], base: [79, 83, 100, 85, 105, 78], catch: 45, exp: 239, growth: 'mediumSlow', male: 0.875, stage: 3,
    moves: L.squirt + ',39 flash-cannon,48 ice-beam',
    look: { shape: 'biped', color: '#4f86d8', accent: '#7a4a24', belly: '#f1e3a2', shell: true, horns: 2, tail: 'curl', size: 1.35 } },

  // ——— Bugs ———
  { id: 10, name: 'Катерпи', types: ['bug'], base: [45, 30, 35, 20, 20, 45], catch: 255, exp: 39, growth: 'mediumFast',
    evo: [{ to: 11, level: 7 }], moves: '1 tackle,1 string-shot,9 bug-bite',
    look: { shape: 'larva', color: '#7ccf4a', accent: '#f2c94c', belly: '#f8e6a0', horns: 1, segments: 4, size: 0.55 } },
  { id: 11, name: 'Метапод', types: ['bug'], base: [50, 20, 55, 25, 25, 30], catch: 120, exp: 72, growth: 'mediumFast', stage: 2,
    evo: [{ to: 12, level: 10 }], moves: '1 tackle,1 string-shot,7 harden,9 bug-bite',
    look: { shape: 'blob', color: '#6fbf3f', accent: '#4f8f2f', spikes: true, size: 0.6 } },
  { id: 12, name: 'Баттерфри', types: ['bug', 'flying'], base: [60, 45, 50, 90, 80, 70], catch: 45, exp: 178, growth: 'mediumFast', stage: 3,
    moves: '1 tackle,1 string-shot,10 gust,12 confusion,14 poison-powder,14 stun-spore,16 sleep-powder,20 psybeam,26 signal-beam,30 air-slash,34 bug-buzz,40 psychic',
    look: { shape: 'bird', color: '#6b6fd8', accent: '#f4f4ff', wings: 'insect', ears: 'long', size: 0.85 } },
  { id: 13, name: 'Видл', types: ['bug', 'poison'], base: [40, 35, 30, 20, 20, 50], catch: 255, exp: 39, growth: 'mediumFast',
    evo: [{ to: 14, level: 7 }], moves: '1 poison-sting,1 string-shot,9 bug-bite',
    look: { shape: 'larva', color: '#d9a04a', accent: '#e8e8e8', belly: '#f4cfa0', horns: 1, tail: 'stinger', segments: 4, size: 0.55 } },
  { id: 14, name: 'Какуна', types: ['bug', 'poison'], base: [45, 25, 50, 25, 25, 35], catch: 120, exp: 72, growth: 'mediumFast', stage: 2,
    evo: [{ to: 15, level: 10 }], moves: '1 poison-sting,1 string-shot,7 harden,9 bug-bite',
    look: { shape: 'blob', color: '#e8c23f', accent: '#b8922f', spikes: true, size: 0.6 } },
  { id: 15, name: 'Бидрилл', types: ['bug', 'poison'], base: [65, 90, 40, 45, 80, 75], catch: 45, exp: 178, growth: 'mediumFast', stage: 3,
    moves: '1 poison-sting,1 string-shot,10 twineedle,13 leer,17 quick-attack,22 swords-dance,26 x-scissor,32 poison-jab,38 agility',
    look: { shape: 'bird', color: '#f2c13a', accent: '#2a2a2a', wings: 'insect', tail: 'stinger', horns: 2, size: 0.9 } },
  { id: 46, name: 'Парас', types: ['bug', 'grass'], base: [35, 70, 55, 45, 55, 25], catch: 190, exp: 57, growth: 'mediumFast',
    evo: [{ to: 47, level: 24 }], moves: L.paras,
    look: { shape: 'larva', color: '#f08a3c', accent: '#d8402f', bulb: 'mushroom', segments: 2, size: 0.55 } },
  { id: 47, name: 'Парасект', types: ['bug', 'grass'], base: [60, 95, 80, 60, 80, 30], catch: 75, exp: 142, growth: 'mediumFast', stage: 2,
    moves: L.paras + ',44 x-scissor',
    look: { shape: 'larva', color: '#e0702c', accent: '#c8302f', bulb: 'mushroom', segments: 3, size: 0.9 } },

  // ——— Birds & normal ———
  { id: 16, name: 'Пиджи', types: ['normal', 'flying'], base: [40, 45, 40, 35, 35, 56], catch: 255, exp: 50, growth: 'mediumSlow',
    evo: [{ to: 17, level: 18 }], moves: L.pidgey,
    look: { shape: 'bird', color: '#b98b5a', accent: '#f1dfb8', belly: '#f1dfb8', wings: 'feather', beak: true, size: 0.55 } },
  { id: 17, name: 'Пиджеотто', types: ['normal', 'flying'], base: [63, 60, 55, 50, 50, 71], catch: 120, exp: 122, growth: 'mediumSlow', stage: 2,
    evo: [{ to: 18, level: 36 }], moves: L.pidgey,
    look: { shape: 'bird', color: '#a8774a', accent: '#d94a3a', belly: '#f1dfb8', wings: 'feather', beak: true, mane: true, size: 0.8 } },
  { id: 18, name: 'Пиджеот', types: ['normal', 'flying'], base: [83, 80, 75, 70, 70, 101], catch: 45, exp: 216, growth: 'mediumSlow', stage: 3,
    moves: L.pidgey + ',44 hurricane',
    look: { shape: 'bird', color: '#a8774a', accent: '#f2c94c', belly: '#f1dfb8', wings: 'feather', beak: true, mane: true, horns: 3, size: 1.15 } },
  { id: 19, name: 'Раттата', types: ['normal'], base: [30, 56, 35, 25, 35, 72], catch: 255, exp: 51, growth: 'mediumFast',
    evo: [{ to: 20, level: 20 }], moves: L.rattata,
    look: { shape: 'quad', color: '#9a6fbf', accent: '#f1e6d0', belly: '#f1e6d0', ears: 'round', tail: 'curl', size: 0.5 } },
  { id: 20, name: 'Ратикейт', types: ['normal'], base: [55, 81, 60, 50, 70, 97], catch: 127, exp: 145, growth: 'mediumFast', stage: 2,
    moves: L.rattata + ',34 crunch',
    look: { shape: 'quad', color: '#c08a4a', accent: '#f1e6d0', belly: '#f1e6d0', ears: 'round', tail: 'thin', size: 0.8 } },
  { id: 21, name: 'Спироу', types: ['normal', 'flying'], base: [40, 60, 30, 31, 31, 70], catch: 255, exp: 52, growth: 'mediumFast',
    evo: [{ to: 22, level: 20 }], moves: L.spearow,
    look: { shape: 'bird', color: '#a0603a', accent: '#d9b380', belly: '#e8cfa0', wings: 'feather', beak: true, size: 0.5 } },
  { id: 22, name: 'Фироу', types: ['normal', 'flying'], base: [65, 90, 65, 61, 61, 100], catch: 90, exp: 155, growth: 'mediumFast', stage: 2,
    moves: L.spearow + ',32 drill-peck',
    look: { shape: 'bird', color: '#a87a4a', accent: '#c8402f', belly: '#e8cfa0', wings: 'feather', beak: true, mane: true, size: 1.0 } },
  { id: 52, name: 'Мяут', types: ['normal'], base: [40, 45, 35, 40, 40, 90], catch: 255, exp: 58, growth: 'mediumFast',
    evo: [{ to: 53, level: 28 }], moves: L.meowth,
    look: { shape: 'biped', color: '#f1e3b8', accent: '#e8c23f', belly: '#fff3d6', ears: 'pointy', tail: 'thin', size: 0.6 } },
  { id: 53, name: 'Персиан', types: ['normal'], base: [65, 70, 60, 65, 65, 115], catch: 90, exp: 154, growth: 'mediumFast', stage: 2,
    moves: L.meowth,
    look: { shape: 'quad', color: '#efd9a0', accent: '#d8402f', belly: '#fff3d6', ears: 'pointy', tail: 'curl', size: 0.95 } },
  { id: 39, name: 'Джигглипафф', types: ['normal', 'fairy'], base: [115, 45, 20, 45, 25, 20], catch: 170, exp: 95, growth: 'fast', male: 0.25,
    evo: [{ to: 40, item: 'moon-stone' }], moves: L.jiggly,
    look: { shape: 'blob', color: '#f7b6d2', accent: '#7fd0e8', ears: 'pointy', size: 0.55 } },
  { id: 40, name: 'Вигглитафф', types: ['normal', 'fairy'], base: [140, 70, 45, 85, 50, 45], catch: 50, exp: 196, growth: 'fast', male: 0.25, stage: 2,
    moves: L.jiggly,
    look: { shape: 'biped', color: '#f7b6d2', accent: '#ffffff', belly: '#ffffff', ears: 'long', size: 0.9 } },
  { id: 133, name: 'Иви', types: ['normal'], base: [55, 55, 50, 45, 65, 55], catch: 45, exp: 65, growth: 'mediumFast', male: 0.875,
    evo: [{ to: 134, item: 'water-stone' }, { to: 135, item: 'thunder-stone' }, { to: 136, item: 'fire-stone' }], moves: L.eevee,
    look: { shape: 'quad', color: '#b07a45', accent: '#f4e6c8', belly: '#e8d0a8', ears: 'long', tail: 'fluffy', mane: true, size: 0.6 } },
  { id: 134, name: 'Вапореон', types: ['water'], base: [130, 65, 60, 110, 95, 65], catch: 45, exp: 184, growth: 'mediumFast', male: 0.875, stage: 2,
    moves: L.eevee + ',1 water-gun,20 water-pulse,29 aqua-tail,37 surf,45 hydro-pump',
    look: { shape: 'quad', color: '#5fb8e0', accent: '#2f5f9f', belly: '#a8dcf0', ears: 'fin', tail: 'fin', mane: true, size: 0.95 } },
  { id: 135, name: 'Джолтеон', types: ['electric'], base: [65, 65, 60, 110, 95, 130], catch: 45, exp: 184, growth: 'mediumFast', male: 0.875, stage: 2,
    moves: L.eevee + ',1 thunder-shock,20 thunder-fang,25 thunder-wave,33 thunderbolt,41 agility,45 thunder',
    look: { shape: 'quad', color: '#f2cf3a', accent: '#ffffff', belly: '#ffe680', ears: 'pointy', tail: 'bolt', spikes: true, mane: true, size: 0.9 } },
  { id: 136, name: 'Флареон', types: ['fire'], base: [65, 130, 60, 95, 110, 65], catch: 45, exp: 184, growth: 'mediumFast', male: 0.875, stage: 2,
    moves: L.eevee + ',1 ember,20 fire-fang,29 flame-wheel,33 flamethrower,45 flare-blitz',
    look: { shape: 'quad', color: '#ee6a2c', accent: '#f6dc8a', belly: '#f6c070', ears: 'long', tail: 'fluffy', mane: true, size: 0.9 } },
  { id: 143, name: 'Снорлакс', types: ['normal'], base: [160, 110, 65, 65, 110, 30], catch: 25, exp: 189, growth: 'slow', male: 0.875,
    moves: '1 tackle,4 defense-curl,9 lick,12 bite,17 headbutt,25 rest,28 body-slam,33 crunch,41 earthquake,49 double-edge',
    look: { shape: 'biped', color: '#2f5f6f', accent: '#f1e3c0', belly: '#f1e3c0', ears: 'pointy', size: 1.6 } },

  // ——— Electric ———
  { id: 25, name: 'Пикачу', types: ['electric'], base: [35, 55, 40, 50, 50, 90], catch: 190, exp: 112, growth: 'mediumFast',
    evo: [{ to: 26, item: 'thunder-stone' }], moves: L.pika,
    look: { shape: 'biped', color: '#f6d33c', accent: '#2a2a2a', belly: '#f6d33c', ears: 'long', tail: 'bolt', size: 0.55 } },
  { id: 26, name: 'Райчу', types: ['electric'], base: [60, 90, 55, 90, 80, 110], catch: 75, exp: 218, growth: 'mediumFast', stage: 2,
    moves: L.pika,
    look: { shape: 'biped', color: '#e8902c', accent: '#f4d36a', belly: '#f6e2a0', ears: 'long', tail: 'thin', size: 0.8 } },
  { id: 81, name: 'Магнемайт', types: ['electric', 'steel'], base: [25, 35, 70, 95, 55, 45], catch: 190, exp: 65, growth: 'mediumFast', male: null,
    evo: [{ to: 82, level: 30 }], moves: L.magne,
    look: { shape: 'blob', color: '#b8c4d0', accent: '#e04040', floating: true, magnet: true, size: 0.5 } },
  { id: 82, name: 'Магнетон', types: ['electric', 'steel'], base: [50, 60, 95, 120, 70, 70], catch: 60, exp: 163, growth: 'mediumFast', male: null, stage: 2,
    moves: L.magne + ',39 flash-cannon,45 thunder',
    look: { shape: 'blob', color: '#a8b4c4', accent: '#e04040', floating: true, magnet: true, segments: 3, size: 0.85 } },

  // ——— Poison & ground ———
  { id: 23, name: 'Эканс', types: ['poison'], base: [35, 60, 44, 40, 54, 55], catch: 255, exp: 58, growth: 'mediumFast',
    evo: [{ to: 24, level: 22 }], moves: L.ekans,
    look: { shape: 'serpent', color: '#9a5fb8', accent: '#f2d04a', belly: '#f2d04a', tail: 'thin', segments: 6, size: 0.7 } },
  { id: 24, name: 'Арбок', types: ['poison'], base: [60, 95, 69, 65, 79, 80], catch: 90, exp: 157, growth: 'mediumFast', stage: 2,
    moves: L.ekans + ',27 crunch',
    look: { shape: 'serpent', color: '#7f4fa8', accent: '#e8c040', belly: '#e8c040', mane: true, segments: 8, size: 1.15 } },
  { id: 41, name: 'Зубат', types: ['poison', 'flying'], base: [40, 45, 35, 30, 40, 55], catch: 255, exp: 49, growth: 'mediumFast',
    evo: [{ to: 42, level: 22 }], moves: L.zubat,
    look: { shape: 'bird', color: '#5f8fd8', accent: '#9f6fd0', wings: 'bat', ears: 'long', floating: true, size: 0.55 } },
  { id: 42, name: 'Голбат', types: ['poison', 'flying'], base: [75, 80, 70, 65, 75, 90], catch: 90, exp: 159, growth: 'mediumFast', stage: 2,
    moves: L.zubat,
    look: { shape: 'bird', color: '#4f7fc8', accent: '#9f5fc0', wings: 'bat', ears: 'pointy', floating: true, size: 0.95 } },
  { id: 43, name: 'Оддиш', types: ['grass', 'poison'], base: [45, 50, 55, 75, 65, 30], catch: 255, exp: 64, growth: 'mediumSlow',
    evo: [{ to: 44, level: 21 }], moves: L.oddish,
    look: { shape: 'blob', color: '#3f5fa8', accent: '#4fbf5f', bulb: 'leaves', size: 0.5 } },
  { id: 44, name: 'Глум', types: ['grass', 'poison'], base: [60, 65, 70, 85, 75, 40], catch: 120, exp: 138, growth: 'mediumSlow', stage: 2,
    evo: [{ to: 45, item: 'leaf-stone' }], moves: L.oddish,
    look: { shape: 'biped', color: '#3f5f98', accent: '#c84a3a', bulb: 'flower', size: 0.7 } },
  { id: 45, name: 'Вайлплум', types: ['grass', 'poison'], base: [75, 80, 85, 110, 90, 50], catch: 45, exp: 221, growth: 'mediumSlow', stage: 3,
    moves: L.oddish + ',45 petal-blizzard',
    look: { shape: 'biped', color: '#3f5fa0', accent: '#e0402f', bulb: 'mushroom', size: 0.95 } },
  { id: 27, name: 'Сэндшру', types: ['ground'], base: [50, 75, 85, 20, 30, 40], catch: 255, exp: 60, growth: 'mediumFast',
    evo: [{ to: 28, level: 22 }], moves: L.sand,
    look: { shape: 'biped', color: '#e2c470', accent: '#b08a40', belly: '#f6e6b0', ears: 'round', tail: 'thin', size: 0.6 } },
  { id: 28, name: 'Сэндслэш', types: ['ground'], base: [75, 100, 110, 45, 55, 65], catch: 90, exp: 158, growth: 'mediumFast', stage: 2,
    moves: L.sand + ',30 x-scissor',
    look: { shape: 'biped', color: '#d8b060', accent: '#9a6a30', belly: '#f6e6b0', spikes: true, tail: 'thin', size: 0.95 } },
  { id: 50, name: 'Диглетт', types: ['ground'], base: [10, 55, 25, 35, 45, 95], catch: 255, exp: 53, growth: 'mediumFast',
    evo: [{ to: 51, level: 26 }], moves: L.diglett,
    look: { shape: 'blob', color: '#9a6a48', accent: '#f08aa0', size: 0.4 } },
  { id: 51, name: 'Дагтрио', types: ['ground'], base: [35, 100, 50, 50, 70, 120], catch: 50, exp: 149, growth: 'mediumFast', stage: 2,
    moves: L.diglett,
    look: { shape: 'blob', color: '#8a5a3a', accent: '#f08aa0', segments: 3, size: 0.65 } },

  // ——— Fairy / fire ———
  { id: 35, name: 'Клефэйри', types: ['fairy'], base: [70, 45, 48, 60, 65, 35], catch: 150, exp: 113, growth: 'fast', male: 0.25,
    evo: [{ to: 36, item: 'moon-stone' }], moves: L.clef,
    look: { shape: 'biped', color: '#f6b8c8', accent: '#8a5040', ears: 'pointy', wings: 'insect', tail: 'curl', size: 0.6 } },
  { id: 36, name: 'Клефейбл', types: ['fairy'], base: [95, 70, 73, 95, 90, 60], catch: 25, exp: 217, growth: 'fast', male: 0.25, stage: 2,
    moves: L.clef,
    look: { shape: 'biped', color: '#f2a8bc', accent: '#8a5040', ears: 'long', wings: 'insect', tail: 'curl', size: 0.95 } },
  { id: 37, name: 'Вульпикс', types: ['fire'], base: [38, 41, 40, 50, 65, 65], catch: 190, exp: 60, growth: 'mediumFast', male: 0.25,
    evo: [{ to: 38, item: 'fire-stone' }], moves: L.vulpix,
    look: { shape: 'quad', color: '#c8603a', accent: '#f0a050', belly: '#e88a50', ears: 'pointy', tail: 'fluffy', mane: true, size: 0.55 } },
  { id: 38, name: 'Найнтейлз', types: ['fire'], base: [73, 76, 75, 81, 100, 100], catch: 75, exp: 177, growth: 'mediumFast', male: 0.25, stage: 2,
    moves: L.vulpix,
    look: { shape: 'quad', color: '#f2e0a8', accent: '#f6f0d8', belly: '#fff4d8', ears: 'pointy', tail: 'fluffy', mane: true, size: 1.0 } },
  { id: 58, name: 'Гроулит', types: ['fire'], base: [55, 70, 45, 70, 50, 60], catch: 190, exp: 70, growth: 'slow', male: 0.75,
    evo: [{ to: 59, item: 'fire-stone' }], moves: L.growl,
    look: { shape: 'quad', color: '#f08a3a', accent: '#2a2a2a', belly: '#f6e0a8', ears: 'round', tail: 'fluffy', mane: true, size: 0.65 } },
  { id: 59, name: 'Арканайн', types: ['fire'], base: [90, 110, 80, 100, 80, 95], catch: 75, exp: 194, growth: 'slow', male: 0.75, stage: 2,
    moves: L.growl + ',34 extreme-speed',
    look: { shape: 'quad', color: '#f07a2a', accent: '#2a2a2a', belly: '#f6e0a8', ears: 'pointy', tail: 'fluffy', mane: true, size: 1.35 } },
  { id: 77, name: 'Понита', types: ['fire'], base: [50, 85, 55, 65, 65, 90], catch: 190, exp: 82, growth: 'mediumFast',
    evo: [{ to: 78, level: 40 }], moves: L.ponyta,
    look: { shape: 'quad', color: '#f6ecd0', accent: '#f6802c', belly: '#fff6e0', ears: 'pointy', tail: 'flame', mane: true, size: 0.9 } },
  { id: 78, name: 'Рапидэш', types: ['fire'], base: [65, 100, 70, 80, 80, 105], catch: 60, exp: 175, growth: 'mediumFast', stage: 2,
    moves: L.ponyta,
    look: { shape: 'quad', color: '#f6ecd0', accent: '#f6602c', belly: '#fff6e0', ears: 'pointy', tail: 'flame', mane: true, horns: 1, size: 1.25 } },

  // ——— Water ———
  { id: 54, name: 'Псайдак', types: ['water'], base: [50, 52, 48, 65, 50, 55], catch: 190, exp: 64, growth: 'mediumFast',
    evo: [{ to: 55, level: 33 }], moves: L.psyduck,
    look: { shape: 'biped', color: '#f6d050', accent: '#f6e8b0', belly: '#f6d050', beak: true, size: 0.6 } },
  { id: 55, name: 'Голдак', types: ['water'], base: [80, 82, 78, 95, 80, 85], catch: 75, exp: 175, growth: 'mediumFast', stage: 2,
    moves: L.psyduck + ',40 hydro-pump',
    look: { shape: 'biped', color: '#3f8fd0', accent: '#f0d070', belly: '#3f8fd0', beak: true, horns: 1, tail: 'thin', size: 1.05 } },
  { id: 60, name: 'Поливаг', types: ['water'], base: [40, 50, 40, 40, 40, 90], catch: 255, exp: 60, growth: 'mediumSlow',
    evo: [{ to: 61, level: 25 }], moves: L.poli,
    look: { shape: 'blob', color: '#5f8fd8', accent: '#f6f6f6', belly: '#f6f6f6', tail: 'fin', size: 0.5 } },
  { id: 61, name: 'Поливирл', types: ['water'], base: [65, 65, 65, 50, 50, 90], catch: 120, exp: 135, growth: 'mediumSlow', stage: 2,
    evo: [{ to: 62, item: 'water-stone' }], moves: L.poli,
    look: { shape: 'biped', color: '#4f7fd0', accent: '#f6f6f6', belly: '#f6f6f6', arms: true, size: 0.8 } },
  { id: 62, name: 'Поливрат', types: ['water', 'fighting'], base: [90, 95, 95, 70, 90, 70], catch: 45, exp: 230, growth: 'mediumSlow', stage: 3,
    moves: L.poli + ',32 brick-break,43 submission,51 close-combat',
    look: { shape: 'biped', color: '#3f6fc0', accent: '#f6f6f6', belly: '#f6f6f6', arms: true, size: 1.15 } },
  { id: 129, name: 'Мэджикарп', types: ['water'], base: [20, 10, 55, 15, 20, 80], catch: 255, exp: 40, growth: 'slow',
    evo: [{ to: 130, level: 20 }], moves: '1 splash,15 tackle',
    look: { shape: 'fish', color: '#e8603a', accent: '#f6e0a0', belly: '#f6e0a0', tail: 'fin', horns: 2, size: 0.6 } },
  { id: 130, name: 'Гаярдос', types: ['water', 'flying'], base: [95, 125, 79, 60, 100, 81], catch: 45, exp: 189, growth: 'slow', stage: 2,
    moves: '1 splash,15 tackle,20 bite,21 leer,24 twister,27 ice-fang,30 aqua-tail,33 waterfall,36 crunch,39 dragon-dance,42 hydro-pump,48 hurricane,52 outrage',
    look: { shape: 'serpent', color: '#3f7fd8', accent: '#f0e0a0', belly: '#f0e0a0', horns: 3, mane: true, tail: 'fin', segments: 9, size: 1.6 } },

  // ——— Psychic / fighting ———
  { id: 63, name: 'Абра', types: ['psychic'], base: [25, 20, 15, 105, 55, 90], catch: 200, exp: 62, growth: 'mediumSlow', male: 0.75,
    evo: [{ to: 64, level: 16 }], moves: '1 teleport',
    look: { shape: 'biped', color: '#e8c050', accent: '#8a5a30', belly: '#8a5a30', ears: 'pointy', tail: 'thin', size: 0.55 } },
  { id: 64, name: 'Кадабра', types: ['psychic'], base: [40, 35, 30, 120, 70, 105], catch: 100, exp: 140, growth: 'mediumSlow', male: 0.75, stage: 2,
    evo: [{ to: 65, level: 36 }], moves: L.kadabra,
    look: { shape: 'biped', color: '#e0b040', accent: '#8a5a30', belly: '#8a5a30', ears: 'pointy', tail: 'thin', horns: 1, size: 0.85 } },
  { id: 65, name: 'Алаказам', types: ['psychic'], base: [55, 50, 45, 135, 95, 120], catch: 50, exp: 225, growth: 'mediumSlow', male: 0.75, stage: 3,
    moves: L.kadabra + ',45 shadow-ball',
    look: { shape: 'biped', color: '#e0b040', accent: '#8a5a30', belly: '#8a5a30', ears: 'pointy', mane: true, size: 1.05 } },
  { id: 56, name: 'Манки', types: ['fighting'], base: [40, 80, 35, 35, 45, 70], catch: 190, exp: 61, growth: 'mediumFast',
    evo: [{ to: 57, level: 28 }], moves: L.mankey,
    look: { shape: 'blob', color: '#f0e0c0', accent: '#a8603a', ears: 'round', tail: 'thin', arms: true, size: 0.55 } },
  { id: 57, name: 'Праймейп', types: ['fighting'], base: [65, 105, 60, 60, 70, 95], catch: 75, exp: 159, growth: 'mediumFast', stage: 2,
    moves: L.mankey,
    look: { shape: 'blob', color: '#e8d8b8', accent: '#8a4a2a', ears: 'round', tail: 'thin', arms: true, size: 0.85 } },
  { id: 66, name: 'Мачоп', types: ['fighting'], base: [70, 80, 50, 35, 35, 35], catch: 180, exp: 61, growth: 'mediumSlow', male: 0.75,
    evo: [{ to: 67, level: 28 }], moves: L.machop,
    look: { shape: 'biped', color: '#9fb0b8', accent: '#d8b8a0', belly: '#b8c4c8', horns: 3, tail: 'thin', size: 0.65 } },
  { id: 67, name: 'Мачок', types: ['fighting'], base: [80, 100, 70, 50, 60, 45], catch: 90, exp: 142, growth: 'mediumSlow', male: 0.75, stage: 2,
    evo: [{ to: 68, level: 40 }], moves: L.machop,
    look: { shape: 'biped', color: '#8f9faf', accent: '#e8c840', belly: '#a8b4c0', horns: 1, size: 1.0 } },
  { id: 68, name: 'Мачамп', types: ['fighting'], base: [90, 130, 80, 65, 85, 55], catch: 45, exp: 227, growth: 'mediumSlow', male: 0.75, stage: 3,
    moves: L.machop,
    look: { shape: 'biped', color: '#8aa0b8', accent: '#e8c840', belly: '#9fb0c4', horns: 3, arms: true, size: 1.3 } },

  // ——— Rock / ghost / dragon ———
  { id: 74, name: 'Джеодуд', types: ['rock', 'ground'], base: [40, 80, 100, 30, 30, 20], catch: 255, exp: 60, growth: 'mediumSlow',
    evo: [{ to: 75, level: 25 }], moves: L.geo,
    look: { shape: 'blob', color: '#9a9488', accent: '#7a746a', arms: true, floating: true, size: 0.55 } },
  { id: 75, name: 'Гравелер', types: ['rock', 'ground'], base: [55, 95, 115, 45, 45, 35], catch: 120, exp: 137, growth: 'mediumSlow', stage: 2,
    evo: [{ to: 76, level: 40 }], moves: L.geo,
    look: { shape: 'blob', color: '#8a8478', accent: '#6a645a', arms: true, spikes: true, size: 0.85 } },
  { id: 76, name: 'Голем', types: ['rock', 'ground'], base: [80, 120, 130, 55, 65, 45], catch: 45, exp: 223, growth: 'mediumSlow', stage: 3,
    moves: L.geo,
    look: { shape: 'quad', color: '#8a7a5a', accent: '#c0a888', belly: '#c0a888', shell: true, size: 1.2 } },
  { id: 95, name: 'Оникс', types: ['rock', 'ground'], base: [35, 45, 160, 30, 45, 70], catch: 45, exp: 77, growth: 'mediumFast',
    moves: '1 tackle,1 harden,4 wrap,7 rock-throw,13 rock-tomb,16 screech,19 bulldoze,25 dragon-breath,28 slam,31 iron-tail,37 rock-slide,40 dig,43 stone-edge,49 earthquake',
    look: { shape: 'serpent', color: '#8a8a8a', accent: '#6a6a6a', horns: 1, segments: 9, size: 1.55 } },
  { id: 92, name: 'Гастли', types: ['ghost', 'poison'], base: [30, 35, 30, 100, 35, 80], catch: 190, exp: 62, growth: 'mediumSlow',
    evo: [{ to: 93, level: 25 }], moves: L.gastly,
    look: { shape: 'blob', color: '#2a2438', accent: '#9a6fd0', floating: true, gas: true, size: 0.55 } },
  { id: 93, name: 'Хонтер', types: ['ghost', 'poison'], base: [45, 50, 45, 115, 55, 95], catch: 90, exp: 142, growth: 'mediumSlow', stage: 2,
    evo: [{ to: 94, level: 40 }], moves: L.gastly,
    look: { shape: 'blob', color: '#6a4fa0', accent: '#2a2438', floating: true, arms: true, spikes: true, size: 0.8 } },
  { id: 94, name: 'Генгар', types: ['ghost', 'poison'], base: [60, 65, 60, 130, 75, 110], catch: 45, exp: 225, growth: 'mediumSlow', stage: 3,
    moves: L.gastly + ',44 shadow-claw',
    look: { shape: 'biped', color: '#5f4a98', accent: '#e04060', belly: '#5f4a98', ears: 'pointy', spikes: true, size: 1.0 } },
  { id: 147, name: 'Дратини', types: ['dragon'], base: [41, 64, 45, 50, 50, 50], catch: 45, exp: 60, growth: 'slow',
    evo: [{ to: 148, level: 30 }], moves: L.dratini,
    look: { shape: 'serpent', color: '#6f9fe0', accent: '#f6f6ff', belly: '#f6f6ff', ears: 'fin', segments: 6, size: 0.75 } },
  { id: 148, name: 'Драгонэйр', types: ['dragon'], base: [61, 84, 65, 70, 70, 70], catch: 45, exp: 147, growth: 'slow', stage: 2,
    evo: [{ to: 149, level: 55 }], moves: L.dratini,
    look: { shape: 'serpent', color: '#4f8fe0', accent: '#f6f6ff', belly: '#f6f6ff', ears: 'fin', horns: 1, segments: 8, size: 1.2 } },
  { id: 149, name: 'Драгонит', types: ['dragon', 'flying'], base: [91, 134, 95, 100, 100, 80], catch: 45, exp: 270, growth: 'slow', stage: 3,
    moves: L.dratini + ',55 wing-attack,61 extreme-speed',
    look: { shape: 'biped', color: '#f0a850', accent: '#4fa88a', belly: '#f6dca0', wings: 'feather', ears: 'long', tail: 'thin', size: 1.45 } },
];

const EN_NAMES: Record<number, string> = {
  1: 'Bulbasaur', 2: 'Ivysaur', 3: 'Venusaur', 4: 'Charmander', 5: 'Charmeleon', 6: 'Charizard',
  7: 'Squirtle', 8: 'Wartortle', 9: 'Blastoise', 10: 'Caterpie', 11: 'Metapod', 12: 'Butterfree',
  13: 'Weedle', 14: 'Kakuna', 15: 'Beedrill', 16: 'Pidgey', 17: 'Pidgeotto', 18: 'Pidgeot',
  19: 'Rattata', 20: 'Raticate', 21: 'Spearow', 22: 'Fearow', 23: 'Ekans', 24: 'Arbok',
  25: 'Pikachu', 26: 'Raichu', 27: 'Sandshrew', 28: 'Sandslash', 35: 'Clefairy', 36: 'Clefable',
  37: 'Vulpix', 38: 'Ninetales', 39: 'Jigglypuff', 40: 'Wigglytuff', 41: 'Zubat', 42: 'Golbat',
  43: 'Oddish', 44: 'Gloom', 45: 'Vileplume', 46: 'Paras', 47: 'Parasect', 50: 'Diglett', 51: 'Dugtrio',
  52: 'Meowth', 53: 'Persian', 54: 'Psyduck', 55: 'Golduck', 56: 'Mankey', 57: 'Primeape',
  58: 'Growlithe', 59: 'Arcanine', 60: 'Poliwag', 61: 'Poliwhirl', 62: 'Poliwrath', 63: 'Abra',
  64: 'Kadabra', 65: 'Alakazam', 66: 'Machop', 67: 'Machoke', 68: 'Machamp', 74: 'Geodude',
  75: 'Graveler', 76: 'Golem', 77: 'Ponyta', 78: 'Rapidash', 81: 'Magnemite', 82: 'Magneton',
  92: 'Gastly', 93: 'Haunter', 94: 'Gengar', 95: 'Onix', 129: 'Magikarp', 130: 'Gyarados',
  133: 'Eevee', 134: 'Vaporeon', 135: 'Jolteon', 136: 'Flareon', 143: 'Snorlax',
  147: 'Dratini', 148: 'Dragonair', 149: 'Dragonite',
};

export const SPECIES: Record<number, Species> = {};
for (const r of RAW) {
  if (!EN_NAMES[r.id]) throw new Error(`Missing English name for #${r.id}`);
  SPECIES[r.id] = {
    id: r.id,
    name: r.name,
    en: EN_NAMES[r.id],
    types: r.types,
    base: { hp: r.base[0], atk: r.base[1], def: r.base[2], spa: r.base[3], spd: r.base[4], spe: r.base[5] },
    catchRate: r.catch,
    baseExp: r.exp,
    growth: r.growth,
    male: r.male === undefined ? 0.5 : r.male,
    evolutions: r.evo ?? [],
    learnset: dedupeLearnset(parseLearnset(r.moves)),
    look: r.look,
    stage: r.stage ?? 1,
  };
}

function dedupeLearnset(ls: [number, string][]): [number, string][] {
  const seen = new Set<string>();
  return ls.filter(([, mv]) => (seen.has(mv) ? false : (seen.add(mv), true)));
}

export const SPECIES_LIST: Species[] = Object.values(SPECIES).sort((a, b) => a.id - b.id);

export function getSpecies(id: number): Species {
  const s = SPECIES[id];
  if (!s) throw new Error(`Unknown species: ${id}`);
  return s;
}

export function dexNo(id: number): string {
  return '#' + String(id).padStart(3, '0');
}
