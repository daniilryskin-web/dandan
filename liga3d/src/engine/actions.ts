import { getItem } from '../data/items';
import { getMove } from '../data/moves';
import { getSpecies } from '../data/species';
import { BADGES, getLocation, type TrainerDef } from '../data/world';
import { applyItemToPokemon, firstAliveIndex, startTrainerBattle, startWildBattle } from './battle';
import type { GameState, Pokemon } from './model';
import { MAX_TEAM } from './model';
import { createPokemon, displayName, evolve, healFully, itemEvolution, makeSlot } from './pokemon';
import { pickWeighted, randInt, type Rng } from './rng';
import { addLog, emptyState, newUid } from './state';

export interface ActionResult {
  ok: boolean;
  message: string;
  battle?: boolean;
}

const ok = (message: string, extra: Partial<ActionResult> = {}): ActionResult => ({ ok: true, message, ...extra });
const fail = (message: string): ActionResult => ({ ok: false, message });

export const STARTERS = [1, 4, 7];

export function newGame(name: string, starterId: number, rng: Rng): GameState {
  if (!STARTERS.includes(starterId)) throw new Error('Этого покемона нельзя выбрать стартовым');
  const state = emptyState(name.trim() || 'Тренер');
  const starter = createPokemon(starterId, 5, rng, { uid: newUid(state), metAt: 'Подарок профессора', shiny: false });
  state.team.push(starter);
  state.dex[starterId] = 'caught';
  addLog(state, `Профессор вручает вам первого покемона — ${displayName(starter)}. Удачи, ${state.player.name}!`, 'good');
  return state;
}

function inBattle(state: GameState): ActionResult | null {
  if (state.battle) return fail('Сначала закончите бой.');
  if (state.pendingEvolution.length || state.pendingLearn.length) return fail('Сначала решите, что делать с новыми атаками и эволюцией.');
  return null;
}

export function canEnter(state: GameState, locId: string): boolean {
  const req = getLocation(locId).requiresBadge;
  return !req || state.player.badges.includes(req);
}

export function travel(state: GameState, locId: string): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  const here = getLocation(state.location);
  if (!here.exits.includes(locId)) return fail('Туда отсюда не пройти.');
  const dest = getLocation(locId);
  if (!canEnter(state, locId)) {
    return fail(`Путь закрыт: нужен ${BADGES[dest.requiresBadge!].name}.`);
  }
  state.location = locId;
  return ok(`Вы пришли на локацию «${dest.name}».`);
}

export function explore(state: GameState, rng: Rng): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  const loc = getLocation(state.location);
  if (!loc.wild?.length && !loc.loot?.length) return fail('Здесь нечего исследовать.');
  if (firstAliveIndex(state.team) < 0) return fail('Все ваши покемоны без сил. Сходите в покецентр.');
  const r = rng();
  if (loc.wild?.length && r < 0.62) {
    const enc = pickWeighted(rng, loc.wild);
    const level = randInt(rng, enc.min, enc.max);
    startWildBattle(state, enc.species, level, rng);
    return ok(`На вас нападает дикий ${getSpecies(enc.species).name}!`, { battle: true });
  }
  if (loc.loot?.length && r < 0.74) {
    const found = pickWeighted(rng, loc.loot);
    state.bag[found.item] = (state.bag[found.item] ?? 0) + 1;
    state.stats.itemsFound++;
    const name = getItem(found.item).name;
    addLog(state, `Найден предмет: ${name} (${loc.name}).`, found.item === 'master-ball' ? 'rare' : 'good');
    return ok(`Вы нашли: ${name}!`);
  }
  const quiet = ['В траве никого.', 'Вокруг тихо...', 'Вы осмотрелись, но ничего не нашли.', 'Где-то шуршат листья, но покемонов не видно.'];
  return ok(quiet[Math.floor(rng() * quiet.length)]);
}

export function bestRod(state: GameState): 1 | 2 | 0 {
  if ((state.bag['good-rod'] ?? 0) > 0) return 2;
  if ((state.bag['old-rod'] ?? 0) > 0) return 1;
  return 0;
}

export function fish(state: GameState, rng: Rng): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  const loc = getLocation(state.location);
  if (!loc.fishing) return fail('Здесь негде рыбачить.');
  const rod = bestRod(state);
  if (!rod) return fail('Нужна удочка. Её можно купить в магазине Камнеграда.');
  if (firstAliveIndex(state.team) < 0) return fail('Все ваши покемоны без сил. Сходите в покецентр.');
  if (rng() < 0.3) return ok('Не клюёт...');
  const table = rod === 2 ? loc.fishing.good : loc.fishing.old;
  const enc = pickWeighted(rng, table);
  startWildBattle(state, enc.species, randInt(rng, enc.min, enc.max), rng);
  return ok('Клюёт!', { battle: true });
}

export function trainersHere(state: GameState): { trainer: TrainerDef; defeated: boolean; gym: boolean }[] {
  const loc = getLocation(state.location);
  const list = (loc.trainers ?? []).map((t) => ({ trainer: t, defeated: state.defeatedTrainers.includes(t.id), gym: false }));
  if (loc.gym) list.push({ trainer: loc.gym, defeated: state.defeatedTrainers.includes(loc.gym.id), gym: true });
  return list;
}

export function challenge(state: GameState, trainerId: string, rng: Rng): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  const entry = trainersHere(state).find((t) => t.trainer.id === trainerId);
  if (!entry) return fail('Такого тренера здесь нет.');
  if (entry.defeated) return fail(`${entry.trainer.title} ${entry.trainer.name} уже побеждён.`);
  if (firstAliveIndex(state.team) < 0) return fail('Все ваши покемоны без сил. Сходите в покецентр.');
  startTrainerBattle(state, entry.trainer, rng);
  return ok(`Бой с: ${entry.trainer.title} ${entry.trainer.name}!`, { battle: true });
}

export function healAtCenter(state: GameState): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  const loc = getLocation(state.location);
  if (!loc.pokecenter) return fail('Здесь нет покецентра.');
  for (const p of state.team) healFully(p);
  state.lastPokecenter = loc.id;
  return ok('Ваши покемоны полностью здоровы! Ждём вас снова.');
}

export function buy(state: GameState, itemId: string, qty: number): ActionResult {
  const loc = getLocation(state.location);
  if (!loc.shop?.includes(itemId)) return fail('Этот товар здесь не продаётся.');
  if (!Number.isInteger(qty) || qty < 1) return fail('Неверное количество.');
  const item = getItem(itemId);
  if (item.kind === 'rod' && (state.bag[itemId] ?? 0) > 0) return fail('У вас уже есть эта удочка.');
  const count = item.kind === 'rod' ? 1 : qty;
  const cost = item.price * count;
  if (cost > state.player.money) return fail('Не хватает денег.');
  state.player.money -= cost;
  state.bag[itemId] = (state.bag[itemId] ?? 0) + count;
  return ok(`Куплено: ${item.name} ×${count} за ${cost} монет.`);
}

export function sellPrice(itemId: string): number {
  return Math.floor(getItem(itemId).price / 2);
}

export function sell(state: GameState, itemId: string, qty: number): ActionResult {
  const loc = getLocation(state.location);
  if (!loc.shop) return fail('Здесь нет магазина.');
  const have = state.bag[itemId] ?? 0;
  const item = getItem(itemId);
  if (item.kind === 'rod' || sellPrice(itemId) <= 0) return fail('Этот предмет нельзя продать.');
  if (!Number.isInteger(qty) || qty < 1 || qty > have) return fail('Неверное количество.');
  state.bag[itemId] = have - qty;
  const gain = sellPrice(itemId) * qty;
  state.player.money += gain;
  return ok(`Продано: ${item.name} ×${qty} за ${gain} монет.`);
}

function findOwned(state: GameState, uid: string): { p: Pokemon; where: 'team' | 'storage'; index: number } | null {
  let index = state.team.findIndex((p) => p.uid === uid);
  if (index >= 0) return { p: state.team[index], where: 'team', index };
  index = state.storage.findIndex((p) => p.uid === uid);
  if (index >= 0) return { p: state.storage[index], where: 'storage', index };
  return null;
}

export function useItem(state: GameState, itemId: string, uid: string): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  if ((state.bag[itemId] ?? 0) <= 0) return fail('Нет такого предмета.');
  const owned = findOwned(state, uid);
  if (!owned || owned.where !== 'team') return fail('Покемон должен быть в команде.');
  const item = getItem(itemId);
  if (item.kind === 'stone') {
    const to = itemEvolution(owned.p, itemId);
    if (!to) return fail('Ничего не произошло.');
    const before = displayName(owned.p);
    state.bag[itemId] -= 1;
    const newMoves = evolve(owned.p, to);
    queueMoves(state, owned.p, newMoves);
    state.dex[to] = 'caught';
    addLog(state, `${before} эволюционирует — теперь это ${getSpecies(to).name}!`, 'rare');
    return ok(`${before} эволюционирует — теперь это ${getSpecies(to).name}!`);
  }
  if (item.kind === 'ball' || item.kind === 'rod') return fail('Этот предмет используется иначе.');
  const res = applyItemToPokemon(owned.p, itemId);
  if (!res.ok) return fail(res.message);
  state.bag[itemId] -= 1;
  return ok(res.message);
}

function queueMoves(state: GameState, p: Pokemon, moves: string[]) {
  for (const mv of moves) {
    if (p.moves.some((m) => m.id === mv)) continue;
    if (p.moves.length < 4) p.moves.push(makeSlot(mv));
    else state.pendingLearn.push({ uid: p.uid, moveId: mv });
  }
}

export function moveInTeam(state: GameState, from: number, to: number): ActionResult {
  if (state.battle) return fail('Во время боя нельзя менять порядок.');
  if (from < 0 || to < 0 || from >= state.team.length || to >= state.team.length) return fail('Неверная позиция.');
  const [p] = state.team.splice(from, 1);
  state.team.splice(to, 0, p);
  return ok(`${displayName(p)} теперь на позиции ${to + 1}.`);
}

export function deposit(state: GameState, uid: string): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  if (!getLocation(state.location).pokecenter) return fail('Питомник доступен только в покецентре.');
  const owned = findOwned(state, uid);
  if (!owned || owned.where !== 'team') return fail('Покемон не найден в команде.');
  if (state.team.length <= 1) return fail('В команде должен остаться хотя бы один покемон.');
  state.team.splice(owned.index, 1);
  healFully(owned.p);
  state.storage.push(owned.p);
  return ok(`${displayName(owned.p)} отправлен в питомник.`);
}

export function withdraw(state: GameState, uid: string): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  if (!getLocation(state.location).pokecenter) return fail('Питомник доступен только в покецентре.');
  const owned = findOwned(state, uid);
  if (!owned || owned.where !== 'storage') return fail('Покемон не найден в питомнике.');
  if (state.team.length >= MAX_TEAM) return fail('В команде уже 6 покемонов.');
  state.storage.splice(owned.index, 1);
  state.team.push(owned.p);
  return ok(`${displayName(owned.p)} присоединяется к команде.`);
}

export function release(state: GameState, uid: string): ActionResult {
  const blocked = inBattle(state);
  if (blocked) return blocked;
  const owned = findOwned(state, uid);
  if (!owned) return fail('Покемон не найден.');
  if (owned.where === 'team' && state.team.length <= 1) return fail('Нельзя отпустить последнего покемона.');
  (owned.where === 'team' ? state.team : state.storage).splice(owned.index, 1);
  addLog(state, `${displayName(owned.p)} отпущен на волю.`);
  return ok(`${displayName(owned.p)} отпущен на волю. Прощай!`);
}

export function rename(state: GameState, uid: string, nickname: string): ActionResult {
  const owned = findOwned(state, uid);
  if (!owned) return fail('Покемон не найден.');
  const clean = nickname.trim().slice(0, 16);
  owned.p.nickname = clean || undefined;
  return ok(clean ? `Теперь его зовут ${clean}.` : 'Кличка сброшена.');
}

/** Resolves the first pending "learn a fifth move" decision. replaceIndex null = give up the new move. */
export function resolveLearn(state: GameState, replaceIndex: number | null): ActionResult {
  const pending = state.pendingLearn.shift();
  if (!pending) return fail('Нет ожидающих атак.');
  const owned = findOwned(state, pending.uid);
  if (!owned) return fail('Покемон не найден.');
  const mv = getMove(pending.moveId);
  if (replaceIndex === null) return ok(`${displayName(owned.p)} не стал учить «${mv.name}».`);
  const old = owned.p.moves[replaceIndex];
  if (!old) return fail('Неверный слот.');
  owned.p.moves[replaceIndex] = makeSlot(pending.moveId);
  return ok(`${displayName(owned.p)} забывает «${getMove(old.id).name}» и изучает «${mv.name}»!`);
}

export function resolveEvolution(state: GameState, accept: boolean): ActionResult {
  const pending = state.pendingEvolution.shift();
  if (!pending) return fail('Нет ожидающих эволюций.');
  const owned = findOwned(state, pending.uid);
  if (!owned) return fail('Покемон не найден.');
  const before = displayName(owned.p);
  if (!accept) return ok(`${before} не эволюционировал.`);
  const newMoves = evolve(owned.p, pending.to);
  queueMoves(state, owned.p, newMoves);
  state.dex[pending.to] = 'caught';
  const after = getSpecies(pending.to).name;
  addLog(state, `${before} эволюционирует — теперь это ${after}!`, 'rare');
  return ok(`Поздравляем! ${before} эволюционирует — теперь это ${after}!`);
}
