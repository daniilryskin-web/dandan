import type { Biome } from '../data/world';

export interface BiomeLook {
  sky: string;
  fog: string;
  fogNear: number;
  fogFar: number;
  ground: string;
  ground2: string;
  platform: string;
  sun: string;
  sunIntensity: number;
  ambient: number;
  hemiSky: string;
  hemiGround: string;
}

export const BIOME_LOOKS: Record<Biome, BiomeLook> = {
  town: { sky: '#9fd4ff', fog: '#cfe9ff', fogNear: 25, fogFar: 60, ground: '#7fc46a', ground2: '#9bd47e', platform: '#c9b98f', sun: '#fff4dc', sunIntensity: 2.2, ambient: 0.5, hemiSky: '#cfe8ff', hemiGround: '#6a8a4a' },
  meadow: { sky: '#a6dcff', fog: '#d6efff', fogNear: 22, fogFar: 60, ground: '#86cd5f', ground2: '#a8dc72', platform: '#7fb85a', sun: '#fff1d0', sunIntensity: 2.4, ambient: 0.5, hemiSky: '#d8f0ff', hemiGround: '#5f8f3a' },
  forest: { sky: '#8fc6a0', fog: '#9fcca8', fogNear: 10, fogFar: 40, ground: '#4c8a3c', ground2: '#5f9a46', platform: '#6a8a46', sun: '#f4ffd8', sunIntensity: 1.6, ambient: 0.45, hemiSky: '#b8e0b0', hemiGround: '#2f4f2a' },
  mountain: { sky: '#b4d2ef', fog: '#d4e4f4', fogNear: 20, fogFar: 65, ground: '#a39580', ground2: '#8f8270', platform: '#9a8c76', sun: '#ffffff', sunIntensity: 2.4, ambient: 0.5, hemiSky: '#e0ecff', hemiGround: '#6a5f50' },
  cave: { sky: '#15121d', fog: '#15121d', fogNear: 6, fogFar: 26, ground: '#4a4352', ground2: '#3a3442', platform: '#5a5262', sun: '#b8a8ff', sunIntensity: 0.5, ambient: 0.35, hemiSky: '#6a5a9a', hemiGround: '#1a1622' },
  lake: { sky: '#a4e0ff', fog: '#d4f0ff', fogNear: 22, fogFar: 62, ground: '#8acb70', ground2: '#a6d88a', platform: '#cdbf8f', sun: '#fff6e0', sunIntensity: 2.3, ambient: 0.5, hemiSky: '#d6f2ff', hemiGround: '#5a8a4a' },
  volcano: { sky: '#e88a5a', fog: '#b0604a', fogNear: 12, fogFar: 45, ground: '#5a3a32', ground2: '#3f2a26', platform: '#6a4a3e', sun: '#ffb070', sunIntensity: 1.8, ambient: 0.4, hemiSky: '#ffb88a', hemiGround: '#3a1a14' },
  plant: { sky: '#8c96aa', fog: '#9aa2b2', fogNear: 15, fogFar: 50, ground: '#6c7076', ground2: '#5c6066', platform: '#7c8086', sun: '#e8eeff', sunIntensity: 1.5, ambient: 0.5, hemiSky: '#b8c0d0', hemiGround: '#3a3e44' },
  hills: { sky: '#bce6ff', fog: '#e0f4ff', fogNear: 25, fogFar: 70, ground: '#98d878', ground2: '#b4e48c', platform: '#9ccf7c', sun: '#fff4d8', sunIntensity: 2.4, ambient: 0.55, hemiSky: '#e4f6ff', hemiGround: '#6a9a4a' },
};

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Smooth-ish deterministic noise for terrain. */
export function terrainNoise(x: number, z: number, seed: number): number {
  const s = (seed % 1000) / 100;
  return (
    Math.sin(x * 0.21 + s) * Math.cos(z * 0.17 - s) * 0.6 +
    Math.sin(x * 0.53 + z * 0.31 + s * 2) * 0.25 +
    Math.cos(x * 0.11 - z * 0.27 + s * 3) * 0.4
  );
}

export function terrainHeight(biome: Biome, x: number, z: number, seed: number): number {
  const r = Math.sqrt(x * x + z * z);
  const edge = Math.max(0, r - 9);
  const n = terrainNoise(x, z, seed);
  switch (biome) {
    case 'mountain':
      return n * 0.4 + edge * edge * 0.12 + Math.max(0, -z - 6) * 0.6;
    case 'hills':
      return n * 0.9 + edge * 0.15;
    case 'cave':
      return n * 0.25 + edge * edge * 0.2;
    case 'volcano':
      return n * 0.35 + edge * 0.2;
    case 'lake': {
      const lake = Math.hypot(x - 1, z + 6);
      return lake < 6 ? -0.6 * (1 - lake / 6) : n * 0.25 + edge * 0.08;
    }
    case 'town':
    case 'plant':
      return r < 10 ? 0 : (r - 10) * 0.15 + n * 0.2;
    default:
      return n * 0.3 + edge * 0.1;
  }
}
