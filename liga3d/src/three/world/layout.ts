import { getLocation, type Biome, type LocationData } from '../../data/world';
import { seededRng, type Rng } from '../../engine/rng';
import { hashString } from '../biomes';

/** Radius of the walkable area of a location. */
export const WORLD_R = 38;
/** Half size of the terrain mesh. */
export const TERRAIN_HALF = 62;

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface Gate {
  to: string;
  x: number;
  z: number;
  angle: number;
}

export type BuildingKind = 'pokecenter' | 'shop' | 'gym' | 'house';

export interface Building {
  kind: BuildingKind;
  x: number;
  z: number;
  rot: number;
  /** Point in front of the door where the interaction prompt appears. */
  door: [number, number];
  roof?: string;
}

export interface TrainerSpot {
  id: string;
  x: number;
  z: number;
  rot: number;
  gym: boolean;
}

export interface TreeInst {
  x: number;
  z: number;
  s: number;
  kind: 'round' | 'pine' | 'palm' | 'dead';
  hue: number;
}

export interface RockInst {
  x: number;
  z: number;
  s: number;
  rot: number;
}

export interface Layout {
  loc: LocationData;
  biome: Biome;
  seed: number;
  gates: Gate[];
  buildings: Building[];
  trainers: TrainerSpot[];
  grass: Circle[];
  lakes: Circle[];
  lava: Circle[];
  trees: TreeInst[];
  rocks: RockInst[];
  flowers: { x: number; z: number; c: number }[];
  obstacles: Circle[];
  paths: [number, number, number, number][];
  height: (x: number, z: number) => number;
  start: [number, number];
}

function noise(x: number, z: number, s: number): number {
  return (
    Math.sin(x * 0.09 + s) * Math.cos(z * 0.08 - s * 1.3) * 0.55 +
    Math.sin(x * 0.21 + z * 0.17 + s * 2.1) * 0.25 +
    Math.cos(x * 0.04 - z * 0.05 + s * 0.7) * 0.6
  );
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function free(p: { x: number; z: number }, r: number, obstacles: Circle[], extra: Circle[] = []): boolean {
  for (const o of obstacles) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + r) return false;
  for (const o of extra) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + r) return false;
  return true;
}

function nearPath(x: number, z: number, paths: Layout['paths'], w: number): boolean {
  return paths.some(([ax, az, bx, bz]) => distToSegment(x, z, ax, az, bx, bz) < w);
}

function ringPoint(rng: Rng, rMin: number, rMax: number): { x: number; z: number } {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rMin * rMin + rng() * (rMax * rMax - rMin * rMin));
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

const cache = new Map<string, Layout>();

/** Deterministic map of a location: terrain, paths, gates, buildings, vegetation and colliders. */
export function getLayout(locId: string): Layout {
  const hit = cache.get(locId);
  if (hit) return hit;
  const loc = getLocation(locId);
  const seed = hashString(loc.id);
  const rng = seededRng(seed);
  const biome = loc.biome;
  const s = (seed % 997) / 97;

  // Gates follow the real direction of the neighbour on the world map.
  const gates: Gate[] = loc.exits.map((to) => {
    const d = getLocation(to);
    const angle = Math.atan2(d.pos[1] - loc.pos[1], d.pos[0] - loc.pos[0]);
    return { to, angle, x: Math.cos(angle) * (WORLD_R - 1.5), z: Math.sin(angle) * (WORLD_R - 1.5) };
  });
  const paths: Layout['paths'] = gates.map((g) => [0, 0, g.x, g.z]);

  const buildings: Building[] = [];
  const obstacles: Circle[] = [];
  const isTown = biome === 'town';
  const addBuilding = (kind: BuildingKind, x: number, z: number, roof?: string) => {
    const rot = Math.atan2(-x, -z);
    const r = kind === 'gym' ? 4.2 : kind === 'pokecenter' ? 3.6 : kind === 'shop' ? 3.0 : 2.6;
    const door: [number, number] = [x + Math.sin(rot) * (r + 1.4), z + Math.cos(rot) * (r + 1.4)];
    buildings.push({ kind, x, z, rot, door, roof });
    obstacles.push({ x, z, r: r + 0.2 });
    paths.push([0, 0, door[0], door[1]]);
  };
  if (loc.pokecenter) addBuilding('pokecenter', -11, -9);
  if (loc.shop) addBuilding('shop', 11, -9);
  if (loc.gym) addBuilding('gym', 0, -19);
  if (biome === 'town') obstacles.push({ x: 0, z: 0, r: 2.9 });
  if (isTown) {
    const roofs = ['#d65a3a', '#4f7fc8', '#5fa04a', '#c8a03a'];
    const spots: [number, number][] = [[-20, 4], [20, 6], [-16, 18], [17, 19], [-25, -16], [25, -15]];
    spots.forEach(([x, z], i) => {
      if (!paths.some(([ax, az, bx, bz]) => distToSegment(x, z, ax, az, bx, bz) < 5)) addBuilding('house', x, z, roofs[i % roofs.length]);
    });
  }

  // Lakes and lava pools.
  const lakes: Circle[] = [];
  const lava: Circle[] = [];
  if (biome === 'lake') lakes.push({ x: 4, z: -12, r: 15 });
  if (biome === 'meadow' || biome === 'hills' || biome === 'forest') {
    for (let i = 0; i < 6 && lakes.length < 1; i++) {
      const p = ringPoint(rng, 14, 28);
      if (!nearPath(p.x, p.z, paths, 9) && free(p, 7, obstacles)) lakes.push({ ...p, r: 5 + rng() * 3 });
    }
  }
  if (biome === 'volcano') {
    for (let i = 0; i < 20 && lava.length < 4; i++) {
      const p = ringPoint(rng, 10, 32);
      if (!nearPath(p.x, p.z, paths, 5) && free(p, 4, obstacles, lava)) lava.push({ ...p, r: 2.5 + rng() * 2.5 });
    }
  }
  for (const w of [...lakes, ...lava]) obstacles.push({ x: w.x, z: w.z, r: w.r - 0.6 });

  const height = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const edge = smooth(WORLD_R - 4, WORLD_R + 14, r);
    let h = noise(x, z, s);
    let rim = 0;
    switch (biome) {
      case 'mountain':
        h = h * 1.6 + Math.max(0, noise(z, x, s + 2)) * 1.5;
        rim = 14;
        break;
      case 'hills':
        h = h * 2.2;
        rim = 7;
        break;
      case 'cave':
        h *= 0.6;
        rim = 18;
        break;
      case 'volcano':
        h *= 1.1;
        rim = 10;
        break;
      case 'town':
      case 'plant':
        h *= 0.5;
        rim = 6;
        break;
      default:
        h *= 1.1;
        rim = 7;
    }
    let y = h + edge * rim * (0.8 + 0.4 * Math.abs(Math.sin(Math.atan2(z, x) * 3 + s)));
    // Gates sit in a pass through the rim.
    for (const g of gates) {
      const d = distToSegment(x, z, g.x * 0.5, g.z * 0.5, g.x * 1.6, g.z * 1.6);
      y = y * smooth(2.5, 9, d) + h * 0.3 * (1 - smooth(2.5, 9, d));
    }
    // Flatten paths, plazas and building pads.
    let flat = 0;
    for (const [ax, az, bx, bz] of paths) flat = Math.max(flat, 1 - smooth(1.6, 4.5, distToSegment(x, z, ax, az, bx, bz)));
    for (const b of buildings) flat = Math.max(flat, 1 - smooth(4, 8, Math.hypot(x - b.x, z - b.z)));
    flat = Math.max(flat, 1 - smooth(isTown ? 8 : 4, isTown ? 12 : 8, r));
    y = y * (1 - flat * 0.85);
    for (const l of lakes) y -= 2.2 * (1 - smooth(l.r * 0.55, l.r + 2.5, Math.hypot(x - l.x, z - l.z)));
    for (const l of lava) y -= 0.9 * (1 - smooth(l.r * 0.6, l.r + 1.5, Math.hypot(x - l.x, z - l.z)));
    return y;
  };

  // Trainers stand along the paths; gym leaders by their gym.
  const trainers: TrainerSpot[] = [];
  (loc.trainers ?? []).forEach((t, i) => {
    const path = paths[i % Math.max(1, gates.length)] ?? [0, 0, 10, 10];
    const k = 0.45 + 0.15 * i;
    const x = path[0] + (path[2] - path[0]) * k + (i % 2 ? 3 : -3);
    const z = path[1] + (path[3] - path[1]) * k + (i % 2 ? -2 : 2);
    trainers.push({ id: t.id, x, z, rot: Math.atan2(-x, -z), gym: false });
    obstacles.push({ x, z, r: 0.6 });
  });
  if (loc.gym) {
    const b = buildings.find((x) => x.kind === 'gym')!;
    trainers.push({ id: loc.gym.id, x: b.door[0] + 2.2, z: b.door[1] + 0.5, rot: Math.atan2(-b.door[0], -b.door[1]), gym: true });
  }

  // Tall grass patches — wild Pokémon hide here.
  const grass: Circle[] = [];
  const grassCount = { meadow: 9, forest: 7, hills: 8, lake: 6, mountain: 4, town: 2, plant: 0, cave: 0, volcano: 0 }[biome];
  for (let i = 0; i < 80 && grass.length < grassCount; i++) {
    const p = ringPoint(rng, isTown ? 24 : 7, WORLD_R - 4);
    const r = 3.5 + rng() * 4;
    if (nearPath(p.x, p.z, paths, 2.5 + r * 0.4) || !free(p, r, obstacles) || grass.some((g) => Math.hypot(g.x - p.x, g.z - p.z) < g.r + r)) continue;
    grass.push({ ...p, r });
  }

  // Trees: dense ring outside the playable area, scattered inside.
  const trees: TreeInst[] = [];
  const treeKind: TreeInst['kind'] =
    biome === 'mountain' || biome === 'cave' ? 'pine' : biome === 'volcano' ? 'dead' : biome === 'forest' && rng() < 0.5 ? 'pine' : 'round';
  const inner = { meadow: 14, forest: 55, hills: 10, lake: 14, mountain: 12, town: 12, plant: 3, cave: 0, volcano: 6 }[biome];
  const outer = { meadow: 70, forest: 110, hills: 50, lake: 70, mountain: 60, town: 60, plant: 25, cave: 0, volcano: 30 }[biome];
  const tryTree = (p: { x: number; z: number }, big: number) => {
    if (nearPath(p.x, p.z, paths, 3.2) || !free(p, 1.4, obstacles, lakes) || Math.hypot(p.x, p.z) < (isTown ? 12 : 6)) return;
    const kind: TreeInst['kind'] = biome === 'forest' ? (rng() < 0.55 ? 'pine' : 'round') : treeKind;
    trees.push({ ...p, s: (0.8 + rng() * 0.6) * big, kind, hue: rng() });
    if (Math.hypot(p.x, p.z) < WORLD_R) obstacles.push({ x: p.x, z: p.z, r: 0.9 * big });
  };
  for (let i = 0; i < inner * 3 && trees.filter((t) => Math.hypot(t.x, t.z) < WORLD_R).length < inner; i++) tryTree(ringPoint(rng, 6, WORLD_R - 3), 1);
  for (let i = 0; i < outer; i++) tryTree(ringPoint(rng, WORLD_R - 2, WORLD_R + 18), 1.25);

  const rocks: RockInst[] = [];
  const rockCount = { meadow: 8, forest: 6, hills: 6, lake: 8, mountain: 40, town: 3, plant: 14, cave: 60, volcano: 34 }[biome];
  for (let i = 0; i < rockCount * 3 && rocks.length < rockCount; i++) {
    const p = ringPoint(rng, 6, WORLD_R + (biome === 'cave' ? 6 : 10));
    if (nearPath(p.x, p.z, paths, 2.6) || !free(p, 1, obstacles)) continue;
    const big = Math.hypot(p.x, p.z) > WORLD_R - 4 ? 1.8 + rng() * 2.4 : 0.5 + rng() * 1.1;
    rocks.push({ ...p, s: big * (biome === 'cave' ? 1.4 : 1), rot: rng() * 6 });
    if (Math.hypot(p.x, p.z) < WORLD_R) obstacles.push({ x: p.x, z: p.z, r: big * 0.75 });
  }

  const flowers: Layout['flowers'] = [];
  const flowerCount = { meadow: 260, forest: 60, hills: 320, lake: 140, mountain: 30, town: 120, plant: 0, cave: 0, volcano: 0 }[biome];
  for (let i = 0; i < flowerCount; i++) {
    const p = ringPoint(rng, 3, WORLD_R + 6);
    if (nearPath(p.x, p.z, paths, 1.8) || !free(p, 0.2, obstacles)) continue;
    flowers.push({ ...p, c: Math.floor(rng() * 5) });
  }

  const layout: Layout = {
    loc, biome, seed, gates, buildings, trainers, grass, lakes, lava, trees, rocks, flowers, obstacles, paths, height, start: isTown ? [0, 8] : [0, 3],
  };
  cache.set(locId, layout);
  return layout;
}

/** Where the player appears when arriving from another location. */
export function arrivalPoint(layout: Layout, from: string | null): [number, number] {
  const g = layout.gates.find((x) => x.to === from);
  if (!g) return layout.start;
  const k = (WORLD_R - 13) / (WORLD_R - 1.5);
  return [g.x * k, g.z * k];
}

/** Random free point for a wild Pokémon, preferring tall grass (or water for water types). */
export function spawnPoint(layout: Layout, rng: Rng, avoid: [number, number], water: boolean): { x: number; z: number; inWater: boolean } | null {
  for (let i = 0; i < 30; i++) {
    let p: { x: number; z: number };
    let inWater = false;
    if (water && layout.lakes.length && rng() < 0.7) {
      const l = layout.lakes[Math.floor(rng() * layout.lakes.length)];
      const a = rng() * Math.PI * 2;
      const r = rng() * (l.r - 1.5);
      p = { x: l.x + Math.cos(a) * r, z: l.z + Math.sin(a) * r };
      inWater = true;
    } else if (layout.grass.length && rng() < 0.75) {
      const g = layout.grass[Math.floor(rng() * layout.grass.length)];
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * g.r * 0.9;
      p = { x: g.x + Math.cos(a) * r, z: g.z + Math.sin(a) * r };
    } else {
      p = ringPoint(rng, 5, WORLD_R - 4);
    }
    if (Math.hypot(p.x - avoid[0], p.z - avoid[1]) < 9) continue;
    if (!inWater && !free(p, 0.8, layout.obstacles)) continue;
    return { ...p, inWater };
  }
  return null;
}

/** Pushes a point out of colliders and keeps it inside the walkable area. */
export function resolveCollision(layout: Layout, x: number, z: number, radius: number): [number, number] {
  let px = x;
  let pz = z;
  for (const o of layout.obstacles) {
    const dx = px - o.x;
    const dz = pz - o.z;
    const d = Math.hypot(dx, dz);
    const min = o.r + radius;
    if (d < min && d > 1e-4) {
      px = o.x + (dx / d) * min;
      pz = o.z + (dz / d) * min;
    }
  }
  const r = Math.hypot(px, pz);
  if (r > WORLD_R) {
    px *= WORLD_R / r;
    pz *= WORLD_R / r;
  }
  return [px, pz];
}
