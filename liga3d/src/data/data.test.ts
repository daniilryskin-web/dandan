import { describe, expect, it } from 'vitest';
import { SPECIES, SPECIES_LIST } from './species';
import { MOVES } from './moves';
import { LOCATION_LIST, LOCATIONS } from './world';
import { ITEMS } from './items';
import { effectiveness, TYPES } from './types';

describe('game data', () => {
  it('every evolution target exists and evolution items are known', () => {
    for (const s of SPECIES_LIST) {
      for (const evo of s.evolutions) {
        expect(SPECIES[evo.to], `${s.name} -> ${evo.to}`).toBeDefined();
        if (evo.item) expect(ITEMS[evo.item]).toBeDefined();
        expect(evo.level !== undefined || evo.item !== undefined).toBe(true);
      }
    }
  });

  it('every species has a level 1 move and only known moves', () => {
    for (const s of SPECIES_LIST) {
      expect(s.learnset.length).toBeGreaterThan(0);
      expect(s.learnset[0][0]).toBe(1);
      for (const [, mv] of s.learnset) expect(MOVES[mv]).toBeDefined();
    }
  });

  it('locations reference existing exits, species, items', () => {
    for (const l of LOCATION_LIST) {
      for (const ex of l.exits) {
        expect(LOCATIONS[ex], `${l.id} -> ${ex}`).toBeDefined();
        expect(LOCATIONS[ex].exits).toContain(l.id);
      }
      const encounters = [...(l.wild ?? []), ...(l.fishing?.old ?? []), ...(l.fishing?.good ?? [])];
      for (const enc of encounters) expect(SPECIES[enc.species], `${l.id}: ${enc.species}`).toBeDefined();
      for (const it of l.shop ?? []) expect(ITEMS[it]).toBeDefined();
      for (const lt of l.loot ?? []) expect(ITEMS[lt.item]).toBeDefined();
      for (const tr of [...(l.trainers ?? []), ...(l.gym ? [l.gym] : [])]) {
        for (const mon of tr.team) expect(SPECIES[mon.species]).toBeDefined();
      }
    }
  });

  it('has all 1025 species with Russian names and sane stats', () => {
    expect(SPECIES_LIST).toHaveLength(1025);
    for (const s of SPECIES_LIST) {
      expect(s.name, `#${s.id}`).toMatch(/[А-Яа-яЁё]/);
      expect(s.types.length).toBeGreaterThan(0);
      expect(s.base.hp).toBeGreaterThan(0);
    }
    expect(SPECIES[25].name).toBe('Пикачу');
    expect(SPECIES[1025].name).toBe('Печарант');
  });

  it('type chart basics', () => {
    expect(TYPES).toHaveLength(18);
    expect(effectiveness('water', ['fire'])).toBe(2);
    expect(effectiveness('electric', ['ground'])).toBe(0);
    expect(effectiveness('grass', ['water', 'ground'])).toBe(4);
    expect(effectiveness('fire', ['water', 'rock'])).toBe(0.25);
    expect(effectiveness('ice', ['dragon', 'flying'])).toBe(4);
  });
});
