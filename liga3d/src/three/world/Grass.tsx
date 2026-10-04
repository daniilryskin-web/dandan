import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { seededRng } from '../../engine/rng';
import { WORLD_R, type Layout } from './layout';
import { PALETTES } from './Terrain';

const shared = { time: { value: 0 } };

function makeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vH;')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
         float h = uv.y;
         vH = h;
         transformed.x *= (1.0 - h * 0.85);
         vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
         float w = sin(uTime * 1.6 + ip.x * 0.33 + ip.z * 0.27) * 0.55 + sin(uTime * 3.3 + ip.x * 0.9 - ip.z * 0.6) * 0.18;
         transformed.x += w * h * h * 0.32;
         transformed.z += w * h * h * 0.14;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= mix(0.5, 1.18, vH);');
  };
  return mat;
}

function blade(width: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, 1, 1, 4);
  g.translate(0, 0.5, 0);
  return g;
}

interface Placed {
  m: THREE.Matrix4[];
  c: THREE.Color[];
}

export interface ClearArea {
  x: number;
  z: number;
  r: number;
}

function place(layout: Layout, count: number, tall: boolean, rng: () => number, clear?: ClearArea): Placed {
  const pal = PALETTES[layout.biome];
  const [c0, c1] = tall ? pal.tall : pal.short;
  const col0 = new THREE.Color(c0);
  const col1 = new THREE.Color(c1);
  const out: Placed = { m: [], c: [] };
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const totalArea = tall ? layout.grass.reduce((s, g) => s + g.r * g.r, 0) : 0;
  let guard = 0;
  while (out.m.length < count && guard++ < count * 4) {
    let x: number;
    let z: number;
    if (tall) {
      if (!layout.grass.length) break;
      let pick = rng() * totalArea;
      let g = layout.grass[0];
      for (const gg of layout.grass) {
        pick -= gg.r * gg.r;
        if (pick <= 0) {
          g = gg;
          break;
        }
      }
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * g.r;
      x = g.x + Math.cos(a) * r;
      z = g.z + Math.sin(a) * r;
    } else {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (WORLD_R + 10);
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      let onPath = false;
      for (const [ax, az, bx, bz] of layout.paths) {
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(x - (ax + t * dx), z - (az + t * dz)) < 2.2) onPath = true;
      }
      if (onPath || (layout.loc.biome === 'town' && Math.hypot(x, z) < 11)) continue;
      if (layout.lakes.some((l) => Math.hypot(x - l.x, z - l.z) < l.r + 1.2)) continue;
      if (layout.lava.some((l) => Math.hypot(x - l.x, z - l.z) < l.r + 1)) continue;
      if (layout.buildings.some((b) => Math.hypot(x - b.x, z - b.z) < 5)) continue;
    }
    if (clear && Math.hypot(x - clear.x, z - clear.z) < clear.r) continue;
    const y = layout.height(x, z);
    const h = tall ? 0.42 + rng() * 0.36 : 0.2 + rng() * 0.26;
    e.set((rng() - 0.5) * 0.35, rng() * Math.PI, (rng() - 0.5) * 0.35);
    q.setFromEuler(e);
    out.m.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.02, z), q, new THREE.Vector3(1, h, 1)));
    out.c.push(col0.clone().lerp(col1, rng()));
  }
  return out;
}

function GrassField({ layout, count, tall, clear }: { layout: Layout; count: number; tall: boolean; clear?: ClearArea }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => blade(tall ? 0.11 : 0.09), [tall]);
  const material = useMemo(makeMaterial, []);
  const placed = useMemo(() => place(layout, count, tall, seededRng(layout.seed + (tall ? 7 : 13)), clear), [layout, count, tall, clear]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    placed.m.forEach((m, i) => mesh.setMatrixAt(i, m));
    placed.c.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.count = placed.m.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placed]);
  if (!placed.m.length) return null;
  return <instancedMesh ref={ref} args={[geometry, material, placed.m.length]} receiveShadow frustumCulled={false} />;
}

export function Grass({ layout, density, clear }: { layout: Layout; density: number; clear?: ClearArea }) {
  useFrame(({ clock }) => {
    shared.time.value = clock.elapsedTime;
  });
  const shortCount = layout.biome === 'cave' || layout.biome === 'volcano' || layout.biome === 'plant' ? Math.round(6000 * density) : Math.round(30000 * density);
  const tallCount = Math.round(Math.min(60000, layout.grass.reduce((s, g) => s + g.r * g.r * Math.PI * 70, 0)) * density);
  return (
    <>
      <GrassField layout={layout} count={tallCount} tall clear={clear} />
      <GrassField layout={layout} count={shortCount} tall={false} clear={clear} />
    </>
  );
}
