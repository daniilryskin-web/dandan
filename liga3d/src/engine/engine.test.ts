import { describe, expect, it } from 'vitest';
import { getMove } from '../data/moves';
import { getSpecies } from '../data/species';
import {
  buy, challenge, deposit, explore, fish, healAtCenter, newGame, resolveEvolution, resolveLearn, travel, useItem, withdraw,
} from './actions';
import { battleTurn, catchShakes, closeBattle, computeDamage, forceSwitch, freshStages, startWildBattle } from './battle';
import type { GameState } from './model';
import { calcStats, createPokemon, expForLevel, gainExp, itemEvolution, levelEvolution, maxHp } from './pokemon';
import { seededRng } from './rng';
import { deserialize, serialize } from './save';

const perfect = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function game(seed = 1): GameState {
  return newGame('Тест', 4, seededRng(seed));
}

/** Fights the current battle to completion using the first move with PP; switches when forced. */
function autoFight(state: GameState, seed = 7, maxTurns = 200) {
  const rng = seededRng(seed);
  for (let i = 0; i < maxTurns && state.battle && state.battle.phase !== 'ended'; i++) {
    if (state.battle.phase === 'forceSwitch') {
      forceSwitch(state, state.team.findIndex((p) => p.hp > 0));
      continue;
    }
    const me = state.team[state.battle.playerActive];
    const idx = Math.max(0, me.moves.findIndex((m) => m.pp > 0 && getMove(m.id).category !== 'status'));
    battleTurn(state, { kind: 'move', index: idx }, rng);
  }
}

describe('pokemon stats', () => {
  it('matches the standard stat formula', () => {
    // Level 50 Charizard, 31 IVs, 0 EVs, neutral nature: HP 153, Spe 120.
    const p = createPokemon(6, 50, seededRng(1), { uid: 'x', ivs: perfect, nature: 'hardy' });
    const s = calcStats(p);
    expect(s.hp).toBe(153);
    expect(s.spe).toBe(120);
    expect(s.spa).toBe(129);
  });

  it('applies nature modifiers', () => {
    const timid = createPokemon(6, 50, seededRng(1), { uid: 'x', ivs: perfect, nature: 'timid' });
    expect(calcStats(timid).spe).toBe(132);
    expect(calcStats(timid).atk).toBe(Math.floor(104 * 0.9));
  });

  it('experience curves', () => {
    expect(expForLevel('mediumFast', 10)).toBe(1000);
    expect(expForLevel('mediumSlow', 5)).toBe(135);
    expect(expForLevel('fast', 100)).toBe(800000);
    expect(expForLevel('slow', 100)).toBe(1250000);
  });

  it('levels up, keeps damage and learns moves', () => {
    const p = createPokemon(4, 5, seededRng(2), { uid: 'x' });
    p.hp -= 3;
    const before = maxHp(p);
    const res = gainExp(p, expForLevel('mediumSlow', 7) - p.exp);
    expect(p.level).toBe(7);
    expect(res.levels).toEqual([6, 7]);
    expect(p.hp).toBe(maxHp(p) - 3);
    expect(maxHp(p)).toBeGreaterThan(before);
    expect(p.moves.map((m) => m.id)).toContain('ember');
  });

  it('starts with the latest four moves', () => {
    const p = createPokemon(1, 20, seededRng(3), { uid: 'x' });
    const expected = [...new Set(getSpecies(1).learnset.filter(([l]) => l <= 20).map(([, m]) => m))].slice(-4);
    expect(p.moves.map((m) => m.id)).toEqual(expected);
  });

  it('erratic and fluctuating curves end where the games do', () => {
    expect(expForLevel('erratic', 100)).toBe(600000);
    expect(expForLevel('fluctuating', 100)).toBe(1640000);
  });

  it('conditional evolutions', () => {
    const eevee = createPokemon(133, 20, seededRng(1), { uid: 'e1' });
    expect(itemEvolution(eevee, 'soothe-bell', new Date(2026, 0, 1, 12))).toBe(196);
    expect(itemEvolution(eevee, 'soothe-bell', new Date(2026, 0, 1, 23))).toBe(197);
    expect(itemEvolution(eevee, 'shiny-stone')).toBe(700);
    const tyrogue = createPokemon(236, 20, seededRng(1), { uid: 't', ivs: { atk: 31, def: 0 }, nature: 'hardy' });
    expect(levelEvolution(tyrogue)).toBe(106);
    const wurmple = createPokemon(265, 7, seededRng(1), { uid: 'w1' });
    expect([266, 268]).toContain(levelEvolution(wurmple));
  });
});

describe('damage', () => {
  it('is super effective with STAB and immune where it should be', () => {
    const rng = seededRng(4);
    const squirtle = createPokemon(7, 20, rng, { uid: 'a', ivs: perfect, nature: 'hardy' });
    const charmander = createPokemon(4, 20, rng, { uid: 'b', ivs: perfect, nature: 'hardy' });
    const geodude = createPokemon(74, 20, rng, { uid: 'c', ivs: perfect, nature: 'hardy' });
    const water = computeDamage(squirtle, charmander, getMove('water-gun'), freshStages(), freshStages(), false, 1);
    const tackle = computeDamage(squirtle, charmander, getMove('tackle'), freshStages(), freshStages(), false, 1);
    expect(water.eff).toBe(2);
    expect(water.damage).toBeGreaterThan(tackle.damage * 2);
    const shock = computeDamage(squirtle, geodude, getMove('thunder-shock'), freshStages(), freshStages(), false, 1);
    expect(shock.eff).toBe(0);
    expect(shock.damage).toBe(0);
    const toss = computeDamage(squirtle, geodude, getMove('seismic-toss'), freshStages(), freshStages(), false, 0);
    expect(toss.damage).toBe(20);
  });
});

describe('catching', () => {
  it('weak, sleeping targets are much easier to catch', () => {
    const rng = seededRng(5);
    const healthy = createPokemon(16, 10, rng, { uid: 'a' });
    const weak = createPokemon(16, 10, rng, { uid: 'b' });
    weak.hp = 1;
    weak.status = 'slp';
    let a = 0;
    let b = 0;
    const r = seededRng(9);
    for (let i = 0; i < 500; i++) {
      if (catchShakes(healthy, 1, r) === 4) a++;
      if (catchShakes(weak, 1, r) === 4) b++;
    }
    expect(b).toBeGreaterThan(a);
    expect(b).toBe(500);
    expect(catchShakes(createPokemon(149, 50, rng, { uid: 'c' }), 255, r)).toBe(4);
  });

  it('throwing a ball in a wild battle can catch and adds to the team', () => {
    const state = game(11);
    state.bag['master-ball'] = 1;
    startWildBattle(state, 16, 3, seededRng(3));
    battleTurn(state, { kind: 'item', itemId: 'master-ball' }, seededRng(4));
    expect(state.battle!.result).toBe('caught');
    expect(state.team).toHaveLength(2);
    expect(state.team[1].species).toBe(16);
    expect(state.dex[16]).toBe('caught');
    closeBattle(state);
    expect(state.battle).toBeNull();
  });

  it('refuses balls in trainer battles without spending a turn', () => {
    const state = game(12);
    travel(state, 'meadow-route');
    challenge(state, 'misha', seededRng(1));
    const before = state.bag['poke-ball'];
    const ev = battleTurn(state, { kind: 'item', itemId: 'poke-ball' }, seededRng(2));
    expect(ev[0]).toMatchObject({ t: 'msg' });
    expect(state.bag['poke-ball']).toBe(before);
    expect(state.battle!.turn).toBe(0);
  });
});

describe('battle flow', () => {
  it('wins a wild battle and gains experience', () => {
    const state = game(21);
    state.team[0].level = 30;
    state.team[0].exp = expForLevel('mediumSlow', 30);
    state.team[0].hp = maxHp(state.team[0]);
    const exp0 = state.team[0].exp;
    startWildBattle(state, 19, 3, seededRng(1));
    autoFight(state);
    expect(state.battle!.result).toBe('win');
    expect(state.team[0].exp).toBeGreaterThan(exp0);
    const money = state.player.money;
    closeBattle(state);
    expect(state.player.money).toBe(money);
  });

  it('losing sends the player to the last pokecenter healed', () => {
    const state = game(22);
    travel(state, 'meadow-route');
    state.team[0].hp = 1;
    state.team[0].moves = [{ id: 'growl', pp: 40, maxPp: 40 }];
    startWildBattle(state, 19, 30, seededRng(2));
    const rng = seededRng(3);
    for (let i = 0; i < 50 && state.battle!.phase === 'choose'; i++) battleTurn(state, { kind: 'move', index: 0 }, rng);
    expect(state.battle!.result).toBe('lose');
    closeBattle(state);
    expect(state.location).toBe('dawn-village');
    expect(state.team[0].hp).toBe(maxHp(state.team[0]));
  });

  it('trainer battle sends out the whole team and pays out', () => {
    const state = game(23);
    travel(state, 'meadow-route');
    state.team[0].level = 40;
    state.team[0].exp = expForLevel('mediumSlow', 40);
    state.team[0].hp = maxHp(state.team[0]);
    const money = state.player.money;
    challenge(state, 'misha', seededRng(5));
    autoFight(state);
    expect(state.battle!.result).toBe('win');
    expect(state.player.money).toBe(money + 160);
    closeBattle(state);
    expect(state.defeatedTrainers).toContain('misha');
    expect(challenge(state, 'misha', seededRng(1)).ok).toBe(false);
  });

  it('queues a level evolution after battle and resolves it', () => {
    const state = game(24);
    const mon = state.team[0];
    mon.level = 15;
    mon.exp = expForLevel('mediumSlow', 16) - 1;
    mon.hp = maxHp(mon);
    startWildBattle(state, 19, 5, seededRng(1));
    autoFight(state);
    closeBattle(state);
    expect(state.pendingEvolution[0]).toEqual({ uid: mon.uid, to: 5 });
    while (state.pendingLearn.length) resolveLearn(state, null);
    const res = resolveEvolution(state, true);
    expect(res.ok).toBe(true);
    expect(state.team[0].species).toBe(5);
    expect(getSpecies(state.team[0].species).name).toBe('Чармелеон');
  });

  it('protect blocks the attack for one turn', () => {
    const state = game(26);
    const me = state.team[0];
    me.moves = [{ id: 'protect', pp: 10, maxPp: 10 }];
    startWildBattle(state, 19, 5, seededRng(2));
    state.battle!.enemyTeam[0].moves = [{ id: 'tackle', pp: 35, maxPp: 35 }];
    const hp = me.hp;
    const ev = battleTurn(state, { kind: 'move', index: 0 }, seededRng(3));
    expect(ev.some((e) => e.t === 'protect')).toBe(true);
    expect(me.hp).toBe(hp);
    expect(state.battle!.volatile.player.protected).toBe(false);
  });

  it('hyper beam forces a recharge turn', () => {
    const state = game(27);
    const me = state.team[0];
    me.level = 50;
    me.exp = expForLevel('mediumSlow', 50);
    me.hp = maxHp(me);
    me.moves = [{ id: 'hyper-beam', pp: 5, maxPp: 5 }];
    startWildBattle(state, 143, 60, seededRng(1));
    const foe = state.battle!.enemyTeam[0];
    foe.moves = [{ id: 'splash', pp: 40, maxPp: 40 }];
    const rng = seededRng(5);
    let ev = battleTurn(state, { kind: 'move', index: 0 }, rng);
    for (let i = 0; i < 10 && !ev.some((e) => e.t === 'damage' && e.side === 'enemy'); i++) ev = battleTurn(state, { kind: 'move', index: 0 }, rng);
    expect(state.battle!.volatile.player.recharge).toBe(true);
    ev = battleTurn(state, { kind: 'move', index: 0 }, rng);
    expect(ev.some((e) => e.t === 'msg' && e.text.includes('восстанавливает силы'))).toBe(true);
  });

  it('confusion can make a pokemon hit itself', () => {
    const state = game(28);
    const me = state.team[0];
    me.moves = [{ id: 'confuse-ray', pp: 10, maxPp: 10 }];
    startWildBattle(state, 19, 5, seededRng(2));
    const foe = state.battle!.enemyTeam[0];
    foe.moves = [{ id: 'tackle', pp: 35, maxPp: 35 }];
    const rng = seededRng(11);
    let confusedSeen = false;
    for (let i = 0; i < 6 && state.battle!.phase === 'choose'; i++) {
      const ev = battleTurn(state, { kind: 'move', index: 0 }, rng);
      if (ev.some((e) => e.t === 'confuse' && e.side === 'enemy')) confusedSeen = true;
    }
    expect(confusedSeen).toBe(true);
  });

  it('switching costs a turn and resets stages', () => {
    const state = game(25);
    state.team.push(createPokemon(16, 5, seededRng(1), { uid: 'zz' }));
    startWildBattle(state, 19, 2, seededRng(2));
    state.battle!.playerStages.atk = 3;
    battleTurn(state, { kind: 'switch', index: 1 }, seededRng(3));
    expect(state.battle!.playerActive).toBe(1);
    expect(state.battle!.playerStages.atk).toBe(0);
    expect(state.battle!.participants).toContain('zz');
  });
});

describe('world actions', () => {
  it('travel respects exits and badges', () => {
    const state = game(31);
    expect(travel(state, 'stonegrad').ok).toBe(false);
    expect(travel(state, 'meadow-route').ok).toBe(true);
    expect(travel(state, 'emerald-forest').ok).toBe(true);
    expect(travel(state, 'stonegrad').ok).toBe(true);
    const pass = travel(state, 'rocky-pass');
    expect(pass.ok).toBe(false);
    state.player.badges.push('stone');
    expect(travel(state, 'rocky-pass').ok).toBe(true);
  });

  it('explore eventually starts a battle or finds an item', () => {
    const state = game(32);
    travel(state, 'meadow-route');
    const rng = seededRng(8);
    let battles = 0;
    for (let i = 0; i < 40; i++) {
      const r = explore(state, rng);
      if (r.battle) {
        battles++;
        state.battle = null;
      }
    }
    expect(battles).toBeGreaterThan(10);
  });

  it('shop, heal, items and storage', () => {
    const state = game(33);
    const money = state.player.money;
    expect(buy(state, 'poke-ball', 5).ok).toBe(true);
    expect(state.player.money).toBe(money - 1000);
    expect(buy(state, 'ultra-ball', 1).ok).toBe(false);
    state.team[0].hp = 3;
    expect(useItem(state, 'potion', state.team[0].uid).ok).toBe(true);
    expect(state.team[0].hp).toBe(Math.min(maxHp(state.team[0]), 23));
    state.team[0].hp = 1;
    healAtCenter(state);
    expect(state.team[0].hp).toBe(maxHp(state.team[0]));
    state.team.push(createPokemon(16, 5, seededRng(1), { uid: 'pidg' }));
    expect(deposit(state, 'pidg').ok).toBe(true);
    expect(state.storage.map((p) => p.uid)).toEqual(['pidg']);
    expect(deposit(state, state.team[0].uid).ok).toBe(false);
    expect(withdraw(state, 'pidg').ok).toBe(true);
    expect(state.team).toHaveLength(2);
  });

  it('stone evolution', () => {
    const state = game(34);
    const pika = createPokemon(25, 10, seededRng(2), { uid: 'pk' });
    state.team.push(pika);
    state.bag['thunder-stone'] = 1;
    expect(useItem(state, 'thunder-stone', 'pk').ok).toBe(true);
    expect(state.team[1].species).toBe(26);
    expect(state.bag['thunder-stone']).toBe(0);
  });

  it('fishing needs a rod', () => {
    const state = game(35);
    travel(state, 'meadow-route');
    travel(state, 'mirror-lake');
    expect(fish(state, seededRng(1)).ok).toBe(false);
    state.bag['old-rod'] = 1;
    let bites = 0;
    const rng = seededRng(2);
    for (let i = 0; i < 20; i++) {
      if (fish(state, rng).battle) {
        bites++;
        expect([129, 60]).toContain(state.battle!.enemyTeam[0].species);
        state.battle = null;
      }
    }
    expect(bites).toBeGreaterThan(5);
  });

  it('save round trip', () => {
    const state = game(36);
    const copy = deserialize(serialize(state));
    expect(copy).toEqual(state);
    expect(() => deserialize('{"version":999}')).toThrow();
  });
});
