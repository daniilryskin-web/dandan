export type ItemKind = 'ball' | 'heal' | 'status' | 'revive' | 'pp' | 'stone' | 'rod' | 'key';

export interface ItemData {
  id: string;
  name: string;
  kind: ItemKind;
  price: number;
  desc: string;
  /** Ball catch multiplier. */
  ball?: number;
  /** HP restored (heal items); Infinity = full. */
  heal?: number;
  cureAll?: boolean;
  cure?: string;
  revive?: number;
  pp?: number;
  /** Fishing rod power: 1 = old, 2 = good. */
  rod?: number;
  icon: string;
}

const LIST: ItemData[] = [
  { id: 'poke-ball', name: 'Покебол', kind: 'ball', price: 200, ball: 1, icon: '#e53935', desc: 'Обычный покебол для ловли диких покемонов.' },
  { id: 'great-ball', name: 'Супербол', kind: 'ball', price: 600, ball: 1.5, icon: '#1e88e5', desc: 'Ловит в 1,5 раза лучше обычного покебола.' },
  { id: 'ultra-ball', name: 'Ультрабол', kind: 'ball', price: 1200, ball: 2, icon: '#fdd835', desc: 'Ловит в 2 раза лучше обычного покебола.' },
  { id: 'net-ball', name: 'Сетьбол', kind: 'ball', price: 1000, ball: 1, icon: '#26a69a', desc: '×3.5 против водных и насекомых.' },
  { id: 'dusk-ball', name: 'Даркбол', kind: 'ball', price: 1000, ball: 1, icon: '#37474f', desc: '×3 в пещерах и против тёмных и призрачных.' },
  { id: 'quick-ball', name: 'Быстробол', kind: 'ball', price: 1000, ball: 1, icon: '#5c6bc0', desc: '×5, если бросить в первый ход боя.' },
  { id: 'master-ball', name: 'Мастербол', kind: 'ball', price: 0, ball: 255, icon: '#8e24aa', desc: 'Ловит любого покемона без промаха.' },

  { id: 'potion', name: 'Зелье', kind: 'heal', price: 300, heal: 20, icon: '#ab47bc', desc: 'Восстанавливает 20 HP.' },
  { id: 'super-potion', name: 'Суперзелье', kind: 'heal', price: 700, heal: 60, icon: '#ec407a', desc: 'Восстанавливает 60 HP.' },
  { id: 'hyper-potion', name: 'Гиперзелье', kind: 'heal', price: 1200, heal: 120, icon: '#ef5350', desc: 'Восстанавливает 120 HP.' },
  { id: 'max-potion', name: 'Максизелье', kind: 'heal', price: 2500, heal: Infinity, icon: '#7e57c2', desc: 'Полностью восстанавливает HP.' },
  { id: 'antidote', name: 'Противоядие', kind: 'status', price: 100, cure: 'psn', icon: '#9ccc65', desc: 'Излечивает отравление.' },
  { id: 'paralyze-heal', name: 'Антипаралитик', kind: 'status', price: 200, cure: 'par', icon: '#ffee58', desc: 'Излечивает паралич.' },
  { id: 'awakening', name: 'Будильник', kind: 'status', price: 250, cure: 'slp', icon: '#90a4ae', desc: 'Будит уснувшего покемона.' },
  { id: 'burn-heal', name: 'Мазь от ожогов', kind: 'status', price: 250, cure: 'brn', icon: '#ffa726', desc: 'Излечивает ожог.' },
  { id: 'ice-heal', name: 'Размораживатель', kind: 'status', price: 250, cure: 'frz', icon: '#4dd0e1', desc: 'Размораживает покемона.' },
  { id: 'full-heal', name: 'Полное лечение', kind: 'status', price: 600, cureAll: true, icon: '#fff176', desc: 'Излечивает любой статус.' },
  { id: 'revive', name: 'Оживитель', kind: 'revive', price: 1500, revive: 0.5, icon: '#ffd54f', desc: 'Оживляет обессиленного покемона с половиной HP.' },
  { id: 'ether', name: 'Эфир', kind: 'pp', price: 1200, pp: 10, icon: '#4fc3f7', desc: 'Восстанавливает 10 PP всем атакам покемона.' },

  { id: 'fire-stone', name: 'Огненный камень', kind: 'stone', price: 2100, icon: '#ff7043', desc: 'Вызывает эволюцию некоторых огненных покемонов.' },
  { id: 'water-stone', name: 'Водный камень', kind: 'stone', price: 2100, icon: '#42a5f5', desc: 'Вызывает эволюцию некоторых водных покемонов.' },
  { id: 'thunder-stone', name: 'Громовой камень', kind: 'stone', price: 2100, icon: '#ffca28', desc: 'Вызывает эволюцию некоторых электрических покемонов.' },
  { id: 'leaf-stone', name: 'Листовой камень', kind: 'stone', price: 2100, icon: '#66bb6a', desc: 'Вызывает эволюцию некоторых травяных покемонов.' },
  { id: 'moon-stone', name: 'Лунный камень', kind: 'stone', price: 3000, icon: '#b0bec5', desc: 'Таинственный камень, вызывающий эволюцию.' },

  { id: 'old-rod', name: 'Старая удочка', kind: 'rod', price: 1500, rod: 1, icon: '#8d6e63', desc: 'Позволяет рыбачить на водоёмах.' },
  { id: 'good-rod', name: 'Хорошая удочка', kind: 'rod', price: 8000, rod: 2, icon: '#5d4037', desc: 'Ловит более редких водных покемонов.' },
];

export const ITEMS: Record<string, ItemData> = Object.fromEntries(LIST.map((i) => [i.id, i]));
export const ITEM_LIST = LIST;

export function getItem(id: string): ItemData {
  const it = ITEMS[id];
  if (!it) throw new Error(`Unknown item: ${id}`);
  return it;
}

export const KIND_LABELS: Record<ItemKind, string> = {
  ball: 'Покеболы',
  heal: 'Лечение',
  status: 'От статусов',
  revive: 'Оживление',
  pp: 'PP',
  stone: 'Камни эволюции',
  rod: 'Удочки',
  key: 'Особые',
};
