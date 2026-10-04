import { getItem } from '../data/items';
import { getMove, STAT_NAMES, STATUS_INFO, type BattleStat, type MoveData, type StatusId } from '../data/moves';
import { getSpecies } from '../data/species';
import { effectiveness } from '../data/types';
import { getLocation, type TrainerDef } from '../data/world';
import type { BattleEvent, BattleResult, BattleState, GameState, Pokemon, Side, Stages, Volatile } from './model';
import { MAX_TEAM } from './model';
import {
  addEvs, calcStats, createPokemon, displayName, evYield, gainExp, healFully, isFainted, levelEvolution, maxHp,
} from './pokemon';
import { chance, randInt, type Rng } from './rng';
import { addLog, markSeen, newUid } from './state';

export const EXP_RATE = 1.5;

export type BattleAction =
  | { kind: 'move'; index: number }
  | { kind: 'switch'; index: number }
  | { kind: 'item'; itemId: string; targetUid?: string }
  | { kind: 'run' };

export function freshVolatile(): Volatile {
  return { confused: 0, recharge: false, protectStreak: 0, protected: false };
}

export function freshStages(): Stages {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
}

function stageMult(stage: number): number {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

function accMult(stage: number): number {
  const s = Math.max(-6, Math.min(6, stage));
  return s >= 0 ? (3 + s) / 3 : 3 / (3 - s);
}

export function firstAliveIndex(team: Pokemon[]): number {
  return team.findIndex((p) => !isFainted(p));
}

// ———————————————————————————————— helpers ————————————————————————————————

interface Ctx {
  state: GameState;
  battle: BattleState;
  ev: BattleEvent[];
  rng: Rng;
  flinch: Record<Side, boolean>;
}

function mon(ctx: Ctx, side: Side): Pokemon {
  return side === 'player' ? ctx.state.team[ctx.battle.playerActive] : ctx.battle.enemyTeam[ctx.battle.enemyActive];
}

function stages(ctx: Ctx, side: Side): Stages {
  return side === 'player' ? ctx.battle.playerStages : ctx.battle.enemyStages;
}

function other(side: Side): Side {
  return side === 'player' ? 'enemy' : 'player';
}

function label(battle: BattleState, side: Side, p: Pokemon): string {
  const name = displayName(p);
  if (side === 'player') return name;
  return battle.kind === 'wild' ? `Дикий ${name}` : `${name} соперника`;
}

function say(ctx: Ctx, text: string) {
  ctx.ev.push({ t: 'msg', text });
}

function effectiveSpeed(p: Pokemon, st: Stages): number {
  const base = calcStats(p).spe * stageMult(st.spe);
  return p.status === 'par' ? base * 0.5 : base;
}

function statusImmune(p: Pokemon, status: StatusId): boolean {
  const types = getSpecies(p.species).types;
  switch (status) {
    case 'brn': return types.includes('fire');
    case 'psn': return types.includes('poison') || types.includes('steel');
    case 'par': return types.includes('electric');
    case 'frz': return types.includes('ice');
    case 'slp': return false;
  }
}

function inflictStatus(ctx: Ctx, side: Side, status: StatusId, fromStatusMove: boolean): boolean {
  const p = mon(ctx, side);
  const name = label(ctx.battle, side, p);
  if (p.status || statusImmune(p, status)) {
    if (fromStatusMove) say(ctx, p.status ? `${name} уже под действием статуса.` : `${name} не поддаётся этому эффекту.`);
    return false;
  }
  p.status = status;
  if (status === 'slp') p.sleepTurns = randInt(ctx.rng, 1, 3);
  ctx.ev.push({ t: 'status', side, status });
  const verbs: Record<StatusId, string> = {
    brn: 'получает ожог!', psn: 'отравлен!', par: 'парализован! Ему трудно двигаться.', slp: 'засыпает!', frz: 'заморожен!',
  };
  say(ctx, `${name} ${verbs[status]}`);
  return true;
}

function changeStages(ctx: Ctx, side: Side, changes: Partial<Record<BattleStat | 'hp', number>>) {
  const st = stages(ctx, side);
  const name = label(ctx.battle, side, mon(ctx, side));
  for (const [k, delta] of Object.entries(changes) as [BattleStat, number][]) {
    if (!(k in st)) continue;
    const before = st[k];
    st[k] = Math.max(-6, Math.min(6, before + delta));
    const real = st[k] - before;
    if (real === 0) {
      say(ctx, `${name}: ${STAT_NAMES[k].toLowerCase()} больше не может ${delta > 0 ? 'расти' : 'падать'}.`);
      continue;
    }
    ctx.ev.push({ t: 'stat', side, stat: k, delta: real });
    const how = real >= 2 ? 'сильно повышается' : real > 0 ? 'повышается' : real <= -2 ? 'сильно понижается' : 'понижается';
    say(ctx, `${name}: ${STAT_NAMES[k].toLowerCase()} ${how}!`);
  }
}

function applyDamage(ctx: Ctx, side: Side, amount: number, eff: number, crit: boolean): number {
  const p = mon(ctx, side);
  const dealt = Math.min(p.hp, amount);
  p.hp -= dealt;
  ctx.ev.push({ t: 'damage', side, amount: dealt, hp: p.hp, eff, crit });
  return dealt;
}

function applyHeal(ctx: Ctx, side: Side, amount: number): number {
  const p = mon(ctx, side);
  const healed = Math.min(maxHp(p) - p.hp, Math.max(0, amount));
  if (healed > 0) {
    p.hp += healed;
    ctx.ev.push({ t: 'heal', side, amount: healed, hp: p.hp });
  }
  return healed;
}

export function computeDamage(
  attacker: Pokemon, defender: Pokemon, move: MoveData, atkSt: Stages, defSt: Stages, crit: boolean, roll: number,
): { damage: number; eff: number } {
  const defTypes = getSpecies(defender.species).types;
  const eff = effectiveness(move.type, defTypes);
  if (eff === 0) return { damage: 0, eff };
  const fixed = move.effect.fixedDamage;
  if (fixed !== undefined) {
    if (fixed === 'level') return { damage: attacker.level, eff: 1 };
    if (fixed === 'half') return { damage: Math.max(1, Math.floor(defender.hp / 2)), eff: 1 };
    return { damage: fixed, eff: 1 };
  }
  const a = calcStats(attacker);
  const d = calcStats(defender);
  const physical = move.category === 'physical';
  let aStage = physical ? atkSt.atk : atkSt.spa;
  let dStage = physical ? defSt.def : defSt.spd;
  if (crit) {
    aStage = Math.max(0, aStage);
    dStage = Math.min(0, dStage);
  }
  const A = (physical ? a.atk : a.spa) * stageMult(aStage);
  const D = (physical ? d.def : d.spd) * stageMult(dStage);
  const power = move.power * (move.effect.hex && defender.status ? 2 : 1);
  const base = Math.floor(Math.floor((Math.floor((2 * attacker.level) / 5 + 2) * power * A) / D) / 50) + 2;
  const stab = getSpecies(attacker.species).types.includes(move.type) ? 1.5 : 1;
  const burn = physical && attacker.status === 'brn' ? 0.5 : 1;
  const random = 0.85 + roll * 0.15;
  const damage = Math.max(1, Math.floor(base * random * stab * eff * (crit ? 1.5 : 1) * burn));
  return { damage, eff };
}

function multiHitCount(rng: Rng, range: [number, number]): number {
  const [lo, hi] = range;
  if (lo === hi) return lo;
  const r = rng();
  if (r < 0.35) return 2;
  if (r < 0.7) return 3;
  if (r < 0.85) return 4;
  return Math.min(hi, 5);
}

// ———————————————————————————————— moves ————————————————————————————————

const STRUGGLE = 'struggle';

function useMove(ctx: Ctx, side: Side, slotIndex: number | 'struggle', movedFirst: boolean) {
  const attacker = mon(ctx, side);
  const defSide = other(side);
  const defender = mon(ctx, defSide);
  const name = label(ctx.battle, side, attacker);
  const vol = ctx.battle.volatile[side];

  if (vol.recharge) {
    vol.recharge = false;
    say(ctx, `${name} восстанавливает силы после мощной атаки.`);
    return;
  }
  if (attacker.status === 'frz') {
    if (ctx.rng() < 0.2) {
      attacker.status = null;
      ctx.ev.push({ t: 'status', side, status: null });
      say(ctx, `${name} оттаивает!`);
    } else {
      say(ctx, `${name} заморожен и не может двигаться!`);
      return;
    }
  }
  if (attacker.status === 'slp') {
    attacker.sleepTurns -= 1;
    if (attacker.sleepTurns > 0) {
      say(ctx, `${name} крепко спит.`);
      return;
    }
    attacker.status = null;
    attacker.sleepTurns = 0;
    ctx.ev.push({ t: 'status', side, status: null });
    say(ctx, `${name} просыпается!`);
  }
  if (ctx.flinch[side]) {
    say(ctx, `${name} дрогнул и не смог атаковать!`);
    return;
  }
  if (vol.confused > 0) {
    vol.confused -= 1;
    if (vol.confused === 0) {
      say(ctx, `${name} больше не в замешательстве!`);
    } else {
      say(ctx, `${name} в замешательстве...`);
      if (ctx.rng() < 1 / 3) {
        const st = stages(ctx, side);
        const s = calcStats(attacker);
        const A = s.atk * stageMult(st.atk);
        const D = s.def * stageMult(st.def);
        const dmg = Math.max(1, Math.floor(Math.floor((Math.floor((2 * attacker.level) / 5 + 2) * 40 * A) / D) / 50) + 2);
        applyDamage(ctx, side, dmg, 1, false);
        say(ctx, `${name} бьёт сам себя в замешательстве!`);
        return;
      }
    }
  }
  if (attacker.status === 'par' && ctx.rng() < 0.25) {
    say(ctx, `${name} парализован и не может двигаться!`);
    return;
  }

  let move: MoveData;
  if (slotIndex === STRUGGLE) {
    move = getMove(STRUGGLE);
    say(ctx, `${name}: не осталось PP!`);
  } else {
    const slot = attacker.moves[slotIndex];
    slot.pp = Math.max(0, slot.pp - 1);
    move = getMove(slot.id);
  }
  ctx.ev.push({ t: 'move', side, moveId: move.id });
  say(ctx, `${name} использует «${move.name}»!`);
  const fx = move.effect;
  if (!fx.protect) vol.protectStreak = 0;

  if (fx.flee) {
    if (ctx.battle.kind === 'wild') {
      say(ctx, side === 'player' ? `${name} телепортируется прочь!` : `${name} исчезает!`);
      finish(ctx, 'fled');
    } else {
      say(ctx, 'Но ничего не произошло!');
    }
    return;
  }

  const targetsFoe = move.category !== 'status' || fx.status !== undefined || fx.confuse !== undefined || fx.stats?.target === 'foe';
  if (targetsFoe && ctx.battle.volatile[defSide].protected) {
    say(ctx, `${label(ctx.battle, defSide, defender)} защищается!`);
    if (fx.selfKO) selfKnockOut(ctx, side);
    return;
  }
  if (fx.ohko) {
    if (attacker.level < defender.level || effectiveness(move.type, getSpecies(defender.species).types) === 0) {
      say(ctx, 'Но ничего не произошло!');
      return;
    }
    if (ctx.rng() * 100 >= 30 + attacker.level - defender.level) {
      ctx.ev.push({ t: 'miss', side });
      say(ctx, `${name} промахивается!`);
      return;
    }
    applyDamage(ctx, defSide, defender.hp, 1, false);
    say(ctx, 'Сокрушительный удар — одним махом!');
    return;
  }
  if (targetsFoe && move.accuracy !== null) {
    const atkSt = stages(ctx, side);
    const defSt = stages(ctx, defSide);
    const acc = move.accuracy * accMult(atkSt.acc - defSt.eva);
    if (ctx.rng() * 100 >= acc) {
      ctx.ev.push({ t: 'miss', side });
      say(ctx, `${name} промахивается!`);
      if (fx.selfKO) selfKnockOut(ctx, side);
      return;
    }
  }

  if (move.category === 'status') {
    runStatusMove(ctx, side, move);
    return;
  }

  // Damaging move.
  const defName = label(ctx.battle, defSide, defender);
  const defTypes = getSpecies(defender.species).types;
  const eff = effectiveness(move.type, defTypes);
  if (eff === 0) {
    say(ctx, `${defName} неуязвим к этой атаке!`);
    if (fx.selfKO) selfKnockOut(ctx, side);
    return;
  }
  const hits = fx.multiHit ? multiHitCount(ctx.rng, fx.multiHit) : 1;
  let total = 0;
  let landed = 0;
  let anyCrit = false;
  for (let i = 0; i < hits; i++) {
    if (defender.hp <= 0) break;
    const crit = fx.fixedDamage === undefined && ctx.rng() < (fx.highCrit ? 1 / 8 : 1 / 24);
    const { damage } = computeDamage(attacker, defender, move, stages(ctx, side), stages(ctx, defSide), crit, ctx.rng());
    total += applyDamage(ctx, defSide, damage, eff, crit);
    landed++;
    anyCrit ||= crit;
  }
  if (anyCrit) say(ctx, 'Критический удар!');
  if (fx.fixedDamage === undefined) {
    if (eff >= 2) say(ctx, 'Это очень эффективно!');
    else if (eff < 1) say(ctx, 'Это не очень эффективно...');
  }
  if (hits > 1) say(ctx, `Нанесено ударов: ${landed}.`);

  if (fx.drain && total > 0) {
    const healed = applyHeal(ctx, side, Math.max(1, Math.floor(total * fx.drain)));
    if (healed > 0) say(ctx, `${defName} теряет силы, а ${name} восстанавливает здоровье.`);
  }
  if (fx.recoil && total > 0) {
    applyDamage(ctx, side, Math.max(1, Math.floor(total * fx.recoil)), 1, false);
    say(ctx, `${name} получает урон от отдачи!`);
  }
  if (fx.payDay && side === 'player') {
    ctx.battle.payDay += attacker.level * 5;
    say(ctx, 'Вокруг рассыпаются монетки!');
  }
  if (defender.status === 'frz' && move.type === 'fire' && defender.hp > 0) {
    defender.status = null;
    ctx.ev.push({ t: 'status', side: defSide, status: null });
    say(ctx, `${defName} оттаивает!`);
  }

  if (defender.hp > 0) {
    if (fx.status && chance(ctx.rng, fx.status.chance)) inflictStatus(ctx, defSide, fx.status.id, false);
    if (fx.confuse && chance(ctx.rng, fx.confuse)) confuse(ctx, defSide, false);
    if (fx.stats?.target === 'foe' && chance(ctx.rng, fx.stats.chance)) changeStages(ctx, defSide, fx.stats.changes);
    if (fx.flinch && movedFirst && chance(ctx.rng, fx.flinch)) ctx.flinch[defSide] = true;
  }
  if (fx.stats?.target === 'self' && attacker.hp > 0 && chance(ctx.rng, fx.stats.chance)) {
    changeStages(ctx, side, fx.stats.changes);
  }
  if (fx.recharge && attacker.hp > 0) vol.recharge = true;
  if (fx.selfKO) selfKnockOut(ctx, side);
}

function selfKnockOut(ctx: Ctx, side: Side) {
  const p = mon(ctx, side);
  if (p.hp > 0) applyDamage(ctx, side, p.hp, 1, false);
}

function confuse(ctx: Ctx, side: Side, fromStatusMove: boolean) {
  const vol = ctx.battle.volatile[side];
  const name = label(ctx.battle, side, mon(ctx, side));
  if (vol.confused > 0) {
    if (fromStatusMove) say(ctx, `${name} уже в замешательстве.`);
    return;
  }
  vol.confused = randInt(ctx.rng, 2, 5);
  ctx.ev.push({ t: 'confuse', side });
  say(ctx, `${name} приходит в замешательство!`);
}

function runStatusMove(ctx: Ctx, side: Side, move: MoveData) {
  const fx = move.effect;
  const user = mon(ctx, side);
  const name = label(ctx.battle, side, user);
  const defSide = other(side);
  const target = mon(ctx, defSide);

  if (fx.rest) {
    if (user.hp >= maxHp(user)) {
      say(ctx, 'Но ничего не произошло!');
      return;
    }
    applyHeal(ctx, side, maxHp(user));
    user.status = 'slp';
    user.sleepTurns = 3;
    ctx.ev.push({ t: 'status', side, status: 'slp' });
    say(ctx, `${name} засыпает и восстанавливает здоровье!`);
    return;
  }
  if (fx.heal) {
    const healed = applyHeal(ctx, side, Math.floor(maxHp(user) * fx.heal));
    say(ctx, healed > 0 ? `${name} восстанавливает здоровье!` : 'Но ничего не произошло!');
    return;
  }
  if (fx.protect) {
    const vol = ctx.battle.volatile[side];
    if (ctx.rng() < 1 / Math.pow(3, vol.protectStreak)) {
      vol.protected = true;
      vol.protectStreak += 1;
      ctx.ev.push({ t: 'protect', side });
      say(ctx, `${name} готовится защищаться!`);
    } else {
      vol.protectStreak = 0;
      say(ctx, 'Но ничего не вышло!');
    }
    return;
  }
  if (fx.confuse && !fx.status && !fx.stats) {
    confuse(ctx, defSide, true);
    return;
  }
  if (fx.status) {
    const targetTypes = getSpecies(target.species).types;
    const powder = move.id.includes('powder') || move.id === 'spore';
    if (effectiveness(move.type, targetTypes) === 0 || (powder && targetTypes.includes('grass'))) {
      say(ctx, `${label(ctx.battle, defSide, target)} не поддаётся этому эффекту.`);
      return;
    }
    inflictStatus(ctx, defSide, fx.status.id, true);
    return;
  }
  if (fx.stats) {
    changeStages(ctx, fx.stats.target === 'self' ? side : defSide, fx.stats.changes);
    if (fx.confuse) confuse(ctx, defSide, false);
    return;
  }
  say(ctx, 'Но ничего не произошло!');
}

// ———————————————————————————————— AI ————————————————————————————————

export function chooseEnemyMove(state: GameState, rng: Rng): number | 'struggle' {
  const battle = state.battle!;
  const enemy = battle.enemyTeam[battle.enemyActive];
  const target = state.team[battle.playerActive];
  const usable = enemy.moves.map((m, i) => ({ m, i })).filter(({ m }) => m.pp > 0);
  if (usable.length === 0) return STRUGGLE;
  if (battle.kind === 'wild') return usable[Math.floor(rng() * usable.length)].i;

  const enemyTypes = getSpecies(enemy.species).types;
  const targetTypes = getSpecies(target.species).types;
  const scored = usable.map(({ m, i }) => {
    const mv = getMove(m.id);
    let score: number;
    if (mv.effect.ohko) {
      score = enemy.level >= target.level ? 40 : 0;
    } else if (mv.category === 'status') {
      if (mv.effect.protect) score = 8;
      else if (mv.effect.status) score = target.status ? 0 : 45;
      else if (mv.effect.heal || mv.effect.rest) score = enemy.hp < maxHp(enemy) * 0.4 ? 80 : 0;
      else score = battle.turn <= 2 ? 25 : 5;
    } else if (mv.effect.fixedDamage !== undefined) {
      const fixed = mv.effect.fixedDamage;
      score = fixed === 'level' ? enemy.level * 1.2 : fixed === 'half' ? target.hp / 2 : fixed;
    } else {
      const eff = effectiveness(mv.type, targetTypes);
      score = mv.power * eff * (enemyTypes.includes(mv.type) ? 1.5 : 1) * ((mv.accuracy ?? 100) / 100);
    }
    return { i, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (rng() < 0.75 && scored[0].score > 0) return scored[0].i;
  return scored[Math.floor(rng() * scored.length)].i;
}

// ———————————————————————————————— start ————————————————————————————————

function baseBattle(state: GameState, kind: BattleState['kind'], enemyTeam: Pokemon[]): BattleState {
  const playerActive = firstAliveIndex(state.team);
  if (playerActive < 0) throw new Error('Нет здоровых покемонов для боя');
  return {
    kind,
    biome: getLocation(state.location).biome,
    enemyTeam,
    enemyActive: 0,
    playerActive,
    playerStages: freshStages(),
    enemyStages: freshStages(),
    volatile: { player: freshVolatile(), enemy: freshVolatile() },
    participants: [state.team[playerActive].uid],
    leveled: [],
    turn: 0,
    runAttempts: 0,
    payDay: 0,
    phase: 'choose',
    result: null,
    lastEvents: [],
    seq: 0,
  };
}

export function startWildBattle(state: GameState, speciesId: number, level: number, rng: Rng, opts: { shiny?: boolean } = {}): BattleState {
  const loc = getLocation(state.location);
  const enemy = createPokemon(speciesId, level, rng, { uid: newUid(state), metAt: loc.name, shiny: opts.shiny });
  const battle = baseBattle(state, 'wild', [enemy]);
  state.battle = battle;
  markSeen(state, speciesId);
  state.stats.encounters++;
  const ev: BattleEvent[] = [{ t: 'msg', text: `Дикий ${displayName(enemy)} (ур. ${level}) нападает!` }];
  if (enemy.shiny) {
    state.stats.shinySeen++;
    ev.push({ t: 'msg', text: '✨ Он сияет! Это шайни-покемон!' });
    addLog(state, `✨ Встречен шайни ${displayName(enemy)} на локации «${loc.name}»!`, 'rare');
  }
  ev.push({ t: 'msg', text: `Вперёд, ${displayName(state.team[battle.playerActive])}!` });
  battle.lastEvents = ev;
  battle.seq++;
  return battle;
}

export function startTrainerBattle(state: GameState, trainer: TrainerDef, rng: Rng): BattleState {
  const team = trainer.team.map((m) =>
    createPokemon(m.species, m.level, rng, { uid: newUid(state), shiny: false, metAt: trainer.name }),
  );
  const battle = baseBattle(state, 'trainer', team);
  battle.trainerId = trainer.id;
  battle.trainerName = `${trainer.title} ${trainer.name}`;
  state.battle = battle;
  markSeen(state, team[0].species);
  battle.lastEvents = [
    { t: 'msg', text: `${battle.trainerName}: «${trainer.intro}»` },
    { t: 'msg', text: `${battle.trainerName} выпускает покемона: ${displayName(team[0])} (ур. ${team[0].level})!` },
    { t: 'msg', text: `Вперёд, ${displayName(state.team[battle.playerActive])}!` },
  ];
  battle.seq++;
  return battle;
}

// ———————————————————————————————— turn ————————————————————————————————

export function battleTurn(state: GameState, action: BattleAction, rng: Rng): BattleEvent[] {
  const battle = state.battle;
  if (!battle || battle.phase !== 'choose') throw new Error('Сейчас нельзя действовать');
  const ctx: Ctx = { state, battle, ev: [], rng, flinch: { player: false, enemy: false } };

  // Actions that don't cost a turn when invalid.
  if (action.kind === 'item') {
    const item = getItem(action.itemId);
    if ((state.bag[action.itemId] ?? 0) <= 0) throw new Error('Нет такого предмета');
    if (item.kind === 'ball' && battle.kind === 'trainer') {
      return publish(ctx, [{ t: 'msg', text: 'Нельзя ловить покемонов другого тренера!' }]);
    }
  }
  if (action.kind === 'run' && battle.kind === 'trainer') {
    return publish(ctx, [{ t: 'msg', text: 'Из боя с тренером нельзя сбежать!' }]);
  }
  if (action.kind === 'switch') {
    const target = state.team[action.index];
    if (!target || isFainted(target) || action.index === battle.playerActive) throw new Error('Нельзя выпустить этого покемона');
  }

  battle.turn += 1;
  const enemyChoice = chooseEnemyMove(state, rng);

  if (action.kind === 'run') {
    if (tryRun(ctx)) return publish(ctx);
    enemyActs(ctx, enemyChoice, false);
  } else if (action.kind === 'switch') {
    switchPlayer(ctx, action.index);
    enemyActs(ctx, enemyChoice, false);
  } else if (action.kind === 'item') {
    const item = getItem(action.itemId);
    if (item.kind === 'ball') {
      if (throwBall(ctx, action.itemId)) return publish(ctx);
    } else {
      useBattleItem(ctx, action.itemId, action.targetUid ?? state.team[battle.playerActive].uid);
    }
    enemyActs(ctx, enemyChoice, false);
  } else {
    const player = state.team[battle.playerActive];
    const slot = player.moves[action.index];
    if (!slot) throw new Error('Нет такой атаки');
    const allEmpty = player.moves.every((m) => m.pp <= 0);
    if (slot.pp <= 0 && !allEmpty) throw new Error('У этой атаки не осталось PP');
    const playerChoice: number | 'struggle' = allEmpty ? STRUGGLE : action.index;
    const pMove = getMove(playerChoice === STRUGGLE ? STRUGGLE : player.moves[playerChoice].id);
    const eMove = getMove(enemyChoice === STRUGGLE ? STRUGGLE : battle.enemyTeam[battle.enemyActive].moves[enemyChoice].id);
    const order = turnOrder(ctx, pMove, eMove);
    for (let i = 0; i < 2; i++) {
      const side = order[i];
      if (battle.phase !== 'choose') break;
      if (mon(ctx, 'player').hp <= 0 || mon(ctx, 'enemy').hp <= 0) break;
      useMove(ctx, side, side === 'player' ? playerChoice : enemyChoice, i === 0);
    }
  }

  if (battle.phase === 'choose') endOfTurn(ctx);
  if (battle.phase === 'choose') resolveFaints(ctx);
  return publish(ctx);
}

function publish(ctx: Ctx, extra: BattleEvent[] = []): BattleEvent[] {
  ctx.ev.push(...extra);
  ctx.battle.lastEvents = ctx.ev;
  ctx.battle.seq++;
  return ctx.ev;
}

function turnOrder(ctx: Ctx, pMove: MoveData, eMove: MoveData): Side[] {
  if (pMove.priority !== eMove.priority) return pMove.priority > eMove.priority ? ['player', 'enemy'] : ['enemy', 'player'];
  const ps = effectiveSpeed(mon(ctx, 'player'), ctx.battle.playerStages);
  const es = effectiveSpeed(mon(ctx, 'enemy'), ctx.battle.enemyStages);
  if (ps === es) return ctx.rng() < 0.5 ? ['player', 'enemy'] : ['enemy', 'player'];
  return ps > es ? ['player', 'enemy'] : ['enemy', 'player'];
}

function enemyActs(ctx: Ctx, choice: number | 'struggle', movedFirst: boolean) {
  if (ctx.battle.phase !== 'choose') return;
  if (mon(ctx, 'enemy').hp <= 0 || mon(ctx, 'player').hp <= 0) return;
  useMove(ctx, 'enemy', choice, movedFirst);
}

function tryRun(ctx: Ctx): boolean {
  const battle = ctx.battle;
  battle.runAttempts += 1;
  const ps = effectiveSpeed(mon(ctx, 'player'), battle.playerStages);
  const es = effectiveSpeed(mon(ctx, 'enemy'), battle.enemyStages);
  const odds = ps >= es ? 256 : Math.floor((ps * 128) / Math.max(1, es)) + 30 * battle.runAttempts;
  if (ctx.rng() * 256 < odds) {
    say(ctx, 'Вы благополучно сбежали!');
    finish(ctx, 'fled');
    return true;
  }
  say(ctx, 'Сбежать не удалось!');
  return false;
}

function switchPlayer(ctx: Ctx, index: number) {
  const battle = ctx.battle;
  const prev = ctx.state.team[battle.playerActive];
  battle.playerActive = index;
  battle.playerStages = freshStages();
  battle.volatile.player = freshVolatile();
  const next = ctx.state.team[index];
  if (!battle.participants.includes(next.uid)) battle.participants.push(next.uid);
  if (prev && prev.hp > 0) say(ctx, `${displayName(prev)}, вернись!`);
  ctx.ev.push({ t: 'switch', side: 'player', uid: next.uid });
  say(ctx, `Вперёд, ${displayName(next)}!`);
}

function useBattleItem(ctx: Ctx, itemId: string, targetUid: string) {
  const state = ctx.state;
  const item = getItem(itemId);
  const target = state.team.find((p) => p.uid === targetUid);
  if (!target) throw new Error('Покемон не найден');
  const result = applyItemToPokemon(target, itemId);
  if (!result.ok) {
    say(ctx, result.message);
    return;
  }
  state.bag[itemId] -= 1;
  say(ctx, `Вы используете «${item.name}». ${result.message}`);
  const isActive = state.team[ctx.battle.playerActive].uid === target.uid;
  if (isActive) {
    if (result.healed) ctx.ev.push({ t: 'heal', side: 'player', amount: result.healed, hp: target.hp });
    if (result.cured) ctx.ev.push({ t: 'status', side: 'player', status: null });
  }
}

export interface ItemUseResult {
  ok: boolean;
  message: string;
  healed?: number;
  cured?: boolean;
}

/** Applies a healing/status/revive/PP item. Does not consume it. */
export function applyItemToPokemon(p: Pokemon, itemId: string): ItemUseResult {
  const item = getItem(itemId);
  const name = displayName(p);
  const mhp = maxHp(p);
  switch (item.kind) {
    case 'heal': {
      if (p.hp <= 0) return { ok: false, message: `${name} без сознания — зелье не поможет.` };
      if (p.hp >= mhp) return { ok: false, message: `${name}: здоровье и так полное.` };
      const healed = Math.min(mhp - p.hp, item.heal === Infinity ? mhp : item.heal ?? 0);
      p.hp += healed;
      return { ok: true, message: `${name} восстанавливает ${healed} HP.`, healed };
    }
    case 'status': {
      if (p.hp <= 0) return { ok: false, message: `${name} без сознания.` };
      if (!p.status || (!item.cureAll && item.cure !== p.status)) return { ok: false, message: 'Это не подействует.' };
      const was = STATUS_INFO[p.status].name;
      p.status = null;
      p.sleepTurns = 0;
      return { ok: true, message: `${name}: статус «${was}» снят.`, cured: true };
    }
    case 'revive': {
      if (p.hp > 0) return { ok: false, message: `${name} и так в сознании.` };
      p.hp = Math.max(1, Math.floor(mhp * (item.revive ?? 0.5)));
      p.status = null;
      return { ok: true, message: `${name} приходит в себя!` };
    }
    case 'pp': {
      if (p.moves.every((m) => m.pp >= m.maxPp)) return { ok: false, message: 'PP и так полные.' };
      for (const m of p.moves) m.pp = Math.min(m.maxPp, m.pp + (item.pp ?? 10));
      return { ok: true, message: `${name}: PP атак восстановлены.` };
    }
    default:
      return { ok: false, message: 'Этот предмет нельзя использовать так.' };
  }
}

export function ballMultiplier(ballId: string, target: Pokemon, battle: BattleState): number {
  const item = getItem(ballId);
  const types = getSpecies(target.species).types;
  switch (ballId) {
    case 'net-ball': return types.includes('water') || types.includes('bug') ? 3.5 : 1;
    case 'dusk-ball': return battle.biome === 'cave' || types.includes('dark') || types.includes('ghost') ? 3 : 1;
    case 'quick-ball': return battle.turn <= 1 ? 5 : 1;
    default: return item.ball ?? 1;
  }
}

/** Gen 6+ style shake check. Returns number of shakes (4 = caught). */
export function catchShakes(target: Pokemon, ballMult: number, rng: Rng): number {
  if (ballMult >= 255) return 4;
  const sp = getSpecies(target.species);
  const mhp = maxHp(target);
  const statusBonus = target.status === 'slp' || target.status === 'frz' ? 2.5 : target.status ? 1.5 : 1;
  const a = (((3 * mhp - 2 * target.hp) * sp.catchRate * ballMult) / (3 * mhp)) * statusBonus;
  if (a >= 255) return 4;
  const b = 65536 / Math.pow(255 / a, 0.1875);
  let shakes = 0;
  while (shakes < 4 && rng() * 65536 < b) shakes++;
  return shakes;
}

function throwBall(ctx: Ctx, ballId: string): boolean {
  const { state, battle } = ctx;
  const item = getItem(ballId);
  const target = battle.enemyTeam[battle.enemyActive];
  state.bag[ballId] -= 1;
  say(ctx, `Вы бросаете ${item.name}!`);
  const shakes = catchShakes(target, ballMultiplier(ballId, target, battle), ctx.rng);
  const caught = shakes === 4;
  ctx.ev.push({ t: 'ball', ball: ballId, shakes: Math.min(shakes, 3), caught });
  if (!caught) {
    const lines = ['О нет! Покемон вырвался!', 'Ах! Почти получилось!', 'Ох! Чуть-чуть не хватило!', 'Совсем немного не хватило!'];
    say(ctx, lines[Math.min(shakes, 3)]);
    return false;
  }
  const name = displayName(target);
  say(ctx, `Попался! ${name} пойман!`);
  target.ball = ballId;
  target.metAt = getLocation(state.location).name;
  target.metLevel = target.level;
  awardExp(ctx, target);
  state.dex[target.species] = 'caught';
  state.stats.caught++;
  if (state.team.length < MAX_TEAM) {
    state.team.push(target);
  } else {
    state.storage.push(target);
    say(ctx, `Команда заполнена — ${name} отправлен в питомник.`);
  }
  addLog(state, `Пойман ${target.shiny ? '✨шайни ' : ''}${name} (ур. ${target.level}) — ${target.metAt}.`, target.shiny ? 'rare' : 'good');
  finish(ctx, 'caught');
  return true;
}

function endOfTurn(ctx: Ctx) {
  ctx.battle.volatile.player.protected = false;
  ctx.battle.volatile.enemy.protected = false;
  for (const side of ['player', 'enemy'] as Side[]) {
    const p = mon(ctx, side);
    if (p.hp <= 0) continue;
    if (p.status === 'brn' || p.status === 'psn') {
      const dmg = Math.max(1, Math.floor(maxHp(p) / (p.status === 'brn' ? 16 : 8)));
      applyDamage(ctx, side, dmg, 1, false);
      say(ctx, `${label(ctx.battle, side, p)} ${p.status === 'brn' ? 'страдает от ожога' : 'страдает от яда'}!`);
    }
  }
}

function resolveFaints(ctx: Ctx) {
  const { state, battle } = ctx;
  const enemy = mon(ctx, 'enemy');
  const player = mon(ctx, 'player');

  if (enemy.hp <= 0) {
    ctx.ev.push({ t: 'faint', side: 'enemy' });
    say(ctx, `${label(battle, 'enemy', enemy)} теряет сознание!`);
    awardExp(ctx, enemy);
    if (battle.kind === 'wild') state.stats.wildDefeated++;
    const next = battle.enemyTeam.findIndex((p, i) => i !== battle.enemyActive && p.hp > 0);
    if (next < 0) {
      if (player.hp <= 0) ctx.ev.push({ t: 'faint', side: 'player' });
      finish(ctx, 'win');
      return;
    }
    battle.enemyActive = next;
    battle.enemyStages = freshStages();
    battle.volatile.enemy = freshVolatile();
    battle.participants = player.hp > 0 ? [player.uid] : [];
    const nm = battle.enemyTeam[next];
    markSeen(state, nm.species);
    ctx.ev.push({ t: 'switch', side: 'enemy', uid: nm.uid });
    say(ctx, `${battle.trainerName} выпускает покемона: ${displayName(nm)} (ур. ${nm.level})!`);
  }

  if (player.hp <= 0) {
    ctx.ev.push({ t: 'faint', side: 'player' });
    say(ctx, `${displayName(player)} теряет сознание!`);
    battle.participants = battle.participants.filter((u) => u !== player.uid);
    if (firstAliveIndex(state.team) < 0) {
      say(ctx, 'У вас не осталось покемонов, способных сражаться...');
      finish(ctx, 'lose');
      return;
    }
    battle.phase = 'forceSwitch';
  }
}

function awardExp(ctx: Ctx, defeated: Pokemon) {
  const { state, battle } = ctx;
  const sp = getSpecies(defeated.species);
  const total = Math.floor(((sp.baseExp * defeated.level) / 7) * (battle.kind === 'trainer' ? 1.5 : 1) * EXP_RATE);
  const alive = battle.participants
    .map((uid) => state.team.find((p) => p.uid === uid))
    .filter((p): p is Pokemon => !!p && p.hp > 0);
  if (alive.length === 0) return;
  const share = Math.max(1, Math.floor(total / alive.length));
  const evs = evYield(defeated.species);
  for (const p of alive) {
    if (p.level >= 100) continue;
    addEvs(p, evs);
    const res = gainExp(p, share);
    ctx.ev.push({ t: 'exp', uid: p.uid, amount: share });
    say(ctx, `${displayName(p)} получает ${share} опыта.`);
    for (const lvl of res.levels) {
      ctx.ev.push({ t: 'levelup', uid: p.uid, level: lvl });
      say(ctx, `${displayName(p)} достигает уровня ${lvl}!`);
    }
    for (const mv of res.learned) {
      ctx.ev.push({ t: 'learn', uid: p.uid, moveId: mv });
      say(ctx, `${displayName(p)} изучает «${getMove(mv).name}»!`);
    }
    for (const mv of res.pending) state.pendingLearn.push({ uid: p.uid, moveId: mv });
    if (res.levels.length && !battle.leveled.includes(p.uid)) battle.leveled.push(p.uid);
  }
}

function finish(ctx: Ctx, result: BattleResult) {
  const { state, battle } = ctx;
  battle.phase = 'ended';
  battle.result = result;
  const loc = getLocation(state.location);
  if (result === 'win') {
    if (battle.kind === 'trainer') {
      const trainer = [...(loc.trainers ?? []), ...(loc.gym ? [loc.gym] : [])].find((t) => t.id === battle.trainerId);
      if (trainer) {
        say(ctx, `${battle.trainerName}: «${trainer.defeat}»`);
        state.player.money += trainer.reward;
        say(ctx, `Вы получаете ${trainer.reward} монет.`);
        if (!state.defeatedTrainers.includes(trainer.id)) state.defeatedTrainers.push(trainer.id);
        state.stats.trainersDefeated++;
        if (trainer.badge && !state.player.badges.includes(trainer.badge)) {
          state.player.badges.push(trainer.badge);
          say(ctx, '🏅 Вы получили значок стадиона!');
          addLog(state, `🏅 Победа на стадионе! ${trainer.title} ${trainer.name} вручает вам значок.`, 'rare');
        } else {
          addLog(state, `Победа в бою: ${battle.trainerName}.`, 'good');
        }
      }
    } else {
      const enemy = battle.enemyTeam[0];
      const coins = enemy.level * 4;
      state.player.money += coins;
      say(ctx, `Вы нашли ${coins} монет.`);
    }
  }
  if (result !== 'lose' && battle.payDay > 0) {
    state.player.money += battle.payDay;
    say(ctx, `Вы подобрали ${battle.payDay} монет.`);
  }
  if (result === 'lose') {
    const lost = Math.floor(state.player.money * 0.1);
    state.player.money -= lost;
    state.stats.losses++;
    say(ctx, `Вы теряете ${lost} монет и спешите в покецентр...`);
    addLog(state, `Поражение в бою${battle.trainerName ? ` (${battle.trainerName})` : ''}. Потеряно ${lost} монет.`, 'bad');
  }
  ctx.ev.push({ t: 'end', result });
}

export function forceSwitch(state: GameState, index: number): BattleEvent[] {
  const battle = state.battle;
  if (!battle || battle.phase !== 'forceSwitch') throw new Error('Сейчас нельзя менять покемона');
  const target = state.team[index];
  if (!target || isFainted(target)) throw new Error('Этот покемон не может сражаться');
  const ctx: Ctx = { state, battle, ev: [], rng: Math.random, flinch: { player: false, enemy: false } };
  battle.playerActive = index;
  battle.playerStages = freshStages();
  battle.volatile.player = freshVolatile();
  if (!battle.participants.includes(target.uid)) battle.participants.push(target.uid);
  ctx.ev.push({ t: 'switch', side: 'player', uid: target.uid });
  say(ctx, `Вперёд, ${displayName(target)}!`);
  battle.phase = 'choose';
  return publish(ctx);
}

/** Leaves the battle screen: applies defeat consequences and queues evolutions. */
export function closeBattle(state: GameState): void {
  const battle = state.battle;
  if (!battle) return;
  if (battle.phase !== 'ended') throw new Error('Бой ещё не окончен');
  if (battle.result === 'lose') {
    state.location = state.lastPokecenter;
    for (const p of state.team) healFully(p);
  } else {
    for (const uid of battle.leveled) {
      const p = state.team.find((x) => x.uid === uid);
      if (!p || p.hp <= 0) continue;
      const to = levelEvolution(p);
      if (to && !state.pendingEvolution.some((e) => e.uid === uid)) state.pendingEvolution.push({ uid, to });
    }
  }
  state.battle = null;
}
