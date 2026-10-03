export type Rng = () => number;

export const defaultRng: Rng = () => Math.random();

/** Deterministic RNG for tests (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng: Rng, percent: number): boolean {
  return rng() * 100 < percent;
}

export function pickWeighted<T extends { weight: number }>(rng: Rng, list: readonly T[]): T {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const x of list) {
    r -= x.weight;
    if (r < 0) return x;
  }
  return list[list.length - 1];
}
