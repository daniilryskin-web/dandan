import { useMemo } from 'react';
import * as THREE from 'three';
import type { Biome } from '../../data/world';
import { TERRAIN_HALF, type Layout } from './layout';

export interface BiomePalette {
  grass: string;
  grass2: string;
  dirt: string;
  sand: string;
  rock: string;
  snow?: string;
  tall: [string, string];
  short: [string, string];
  plaza?: string;
}

export const PALETTES: Record<Biome, BiomePalette> = {
  town: { grass: '#78c850', grass2: '#9ad95f', dirt: '#e0c48c', sand: '#ead9a6', rock: '#a59d90', tall: ['#3f9a3a', '#7fd14f'], short: ['#5cae40', '#9be05e'], plaza: '#dcd2bc' },
  meadow: { grass: '#74c64a', grass2: '#a3dc5a', dirt: '#dcbc82', sand: '#ead9a6', rock: '#a8a094', tall: ['#3c9636', '#86d84f'], short: ['#5eb03f', '#a6e264'] },
  forest: { grass: '#4c9a3a', grass2: '#6cb444', dirt: '#b99260', sand: '#d9c48c', rock: '#8e877c', tall: ['#2f7a2c', '#5fb43f'], short: ['#3f8a33', '#78c24a'] },
  mountain: { grass: '#8aa860', grass2: '#a2b878', dirt: '#b8a07a', sand: '#d2c4a0', rock: '#9a9286', snow: '#f4f7fb', tall: ['#6a8a44', '#a6bf6a'], short: ['#7a9a50', '#b2c87a'] },
  cave: { grass: '#4c4558', grass2: '#5a5266', dirt: '#6a6070', sand: '#7a7080', rock: '#5c5468', tall: ['#3a344a', '#5a5070'], short: ['#3a344a', '#5a5070'] },
  lake: { grass: '#72c44e', grass2: '#98d862', dirt: '#d8ba82', sand: '#ecdcaa', rock: '#a69e92', tall: ['#3a9238', '#80d24e'], short: ['#5aae40', '#9ee060'] },
  volcano: { grass: '#5a3e34', grass2: '#6e4a3a', dirt: '#7a5440', sand: '#8a6450', rock: '#3e2c28', tall: ['#6a5030', '#a07840'], short: ['#5a4430', '#8a6840'] },
  plant: { grass: '#7d8a6a', grass2: '#8e9878', dirt: '#9a948a', sand: '#aaa496', rock: '#787c82', tall: ['#5a6a48', '#8a9a68'], short: ['#5a6a48', '#8a9a68'], plaza: '#8c9096' },
  hills: { grass: '#86d05a', grass2: '#b0e36c', dirt: '#e0c48c', sand: '#ecdcaa', rock: '#aaa296', tall: ['#4aa23e', '#9be45a'], short: ['#6cbc48', '#b6ea70'] },
};

function segDist(px: number, pz: number, s: [number, number, number, number]): number {
  const [ax, az, bx, bz] = s;
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export function Terrain({ layout, segments = 180 }: { layout: Layout; segments?: number }) {
  const geometry = useMemo(() => {
    const pal = PALETTES[layout.biome];
    const g = new THREE.PlaneGeometry(TERRAIN_HALF * 2, TERRAIN_HALF * 2, segments, segments);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const cGrass = new THREE.Color(pal.grass);
    const cGrass2 = new THREE.Color(pal.grass2);
    const cDirt = new THREE.Color(pal.dirt);
    const cSand = new THREE.Color(pal.sand);
    const cRock = new THREE.Color(pal.rock);
    const cSnow = new THREE.Color(pal.snow ?? '#ffffff');
    const cPlaza = new THREE.Color(pal.plaza ?? pal.dirt);
    const c = new THREE.Color();
    const h = layout.height;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = h(x, z);
      pos.setY(i, y);
      const slope = Math.hypot(h(x + 0.6, z) - y, h(x, z + 0.6) - y) / 0.6;
      const n = 0.5 + 0.5 * Math.sin(x * 0.31 + z * 0.17) * Math.cos(z * 0.23 - x * 0.11);
      c.copy(cGrass).lerp(cGrass2, n * 0.8);
      let pathD = Infinity;
      for (const p of layout.paths) pathD = Math.min(pathD, segDist(x, z, p));
      const path = 1 - Math.min(1, Math.max(0, (pathD - 1.2) / 1.4));
      if (path > 0) c.lerp(cDirt, path * 0.92);
      const r = Math.hypot(x, z);
      if (pal.plaza && r < 7.5) c.lerp(cPlaza, Math.min(1, (7.5 - r) / 1.5));
      for (const l of layout.lakes) {
        const d = Math.hypot(x - l.x, z - l.z) - l.r;
        if (d < 2.5) c.lerp(cSand, Math.min(1, (2.5 - d) / 2));
      }
      for (const l of layout.lava) {
        const d = Math.hypot(x - l.x, z - l.z) - l.r;
        if (d < 1.5) c.lerp(new THREE.Color('#2a1a14'), Math.min(1, (1.5 - d) / 1.5));
      }
      if (slope > 0.55) c.lerp(cRock, Math.min(1, (slope - 0.55) * 1.6));
      if (pal.snow && y > 7) c.lerp(cSnow, Math.min(1, (y - 7) / 3));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [layout, segments]);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.95} metalness={0} />
    </mesh>
  );
}
