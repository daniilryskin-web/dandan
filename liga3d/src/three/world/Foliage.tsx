import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Layout, TreeInst } from './layout';

function roundCanopy(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number][] = [
    [0, 3.0, 0, 1.55], [0.95, 2.6, 0.35, 1.05], [-0.85, 2.7, -0.3, 1.1], [0.2, 2.5, -0.95, 1.0], [-0.25, 3.7, 0.2, 1.0], [0.3, 2.45, 0.95, 0.95],
  ];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 2);
    g.translate(x, y, z);
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}

function pineCanopy(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const levels: [number, number, number][] = [[1.7, 1.9, 1.8], [1.35, 1.6, 2.9], [0.95, 1.4, 3.9], [0.55, 1.1, 4.8]];
  for (const [r, h, y] of levels) {
    const g = new THREE.ConeGeometry(r, h, 10, 1);
    g.translate(0, y, 0);
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}

function deadCanopy(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const branches: [number, number, number, number][] = [[0.6, 2.4, 0.9, 0.7], [-0.7, 2.9, -0.8, -0.6], [0.2, 3.3, 0.5, 0.2]];
  for (const [x, y, rz, ry] of branches) {
    const g = new THREE.CylinderGeometry(0.05, 0.1, 1.4, 5);
    g.rotateZ(rz);
    g.rotateY(ry);
    g.translate(x, y, 0);
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}

function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 0.82 + 0.25 * Math.sin(x * 3.1 + z * 2.3) * Math.cos(y * 2.7 - x);
    p.setXYZ(i, x * k, Math.max(-0.35, y * k * 0.72), z * k);
  }
  g.computeVertexNormals();
  return g;
}

function Instanced({ geometry, items, color, castShadow = true, roughness = 0.9, flat = false }: {
  geometry: THREE.BufferGeometry;
  items: { m: THREE.Matrix4; c: THREE.Color }[];
  color?: string;
  castShadow?: boolean;
  roughness?: number;
  flat?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, it.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, items.length]} castShadow={castShadow} receiveShadow>
      <meshStandardMaterial color={color ?? '#ffffff'} roughness={roughness} flatShading={flat} />
    </instancedMesh>
  );
}

const TRUNK = new THREE.CylinderGeometry(0.22, 0.34, 2.4, 8);
TRUNK.translate(0, 1.2, 0);

function treeMatrix(t: TreeInst, y: number, extraScale = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(t.x, y - 0.1, t.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.hue * 6.28),
    new THREE.Vector3(t.s * extraScale, t.s * extraScale, t.s * extraScale),
  );
}

export function Trees({ layout }: { layout: Layout }) {
  const geos = useMemo(() => ({ round: roundCanopy(), pine: pineCanopy(), dead: deadCanopy() }), []);
  const data = useMemo(() => {
    const trunks: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const round: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const pine: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const dead: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const autumn = layout.biome === 'hills';
    for (const t of layout.trees) {
      const y = layout.height(t.x, t.z);
      const m = treeMatrix(t, y);
      trunks.push({ m, c: new THREE.Color(t.kind === 'dead' ? '#3a2a22' : '#7a5236') });
      if (t.kind === 'round') {
        const c = new THREE.Color().setHSL(autumn && t.hue > 0.75 ? 0.08 : 0.27 + t.hue * 0.08, 0.55, 0.36 + t.hue * 0.1);
        round.push({ m, c });
      } else if (t.kind === 'pine') {
        pine.push({ m, c: new THREE.Color().setHSL(0.36 + t.hue * 0.05, 0.45, 0.26 + t.hue * 0.08) });
      } else if (t.kind === 'dead') {
        dead.push({ m, c: new THREE.Color('#3a2a22') });
      }
    }
    return { trunks, round, pine, dead };
  }, [layout]);
  return (
    <>
      <Instanced geometry={TRUNK} items={data.trunks} />
      <Instanced geometry={geos.round} items={data.round} roughness={0.85} />
      <Instanced geometry={geos.pine} items={data.pine} roughness={0.85} />
      <Instanced geometry={geos.dead} items={data.dead} />
    </>
  );
}

export function Rocks({ layout }: { layout: Layout }) {
  const geo = useMemo(rockGeometry, []);
  const items = useMemo(() => {
    const base = { cave: '#5e566c', volcano: '#3f2e2a', mountain: '#9a9286', plant: '#7a7e84' }[layout.biome as string] ?? '#a39b8f';
    return layout.rocks.map((r) => ({
      m: new THREE.Matrix4().compose(
        new THREE.Vector3(r.x, layout.height(r.x, r.z) + r.s * 0.12, r.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, r.rot, 0.1)),
        new THREE.Vector3(r.s, r.s, r.s),
      ),
      c: new THREE.Color(base).offsetHSL(0, 0, (r.rot % 1) * 0.12 - 0.06),
    }));
  }, [layout]);
  return <Instanced geometry={geo} items={items} flat roughness={0.95} />;
}

const FLOWER_COLORS = ['#ff7aa8', '#ffd54f', '#ffffff', '#b388ff', '#ff8a65'];

export function Flowers({ layout }: { layout: Layout }) {
  const geo = useMemo(() => {
    const g = new THREE.IcosahedronGeometry(0.11, 0);
    g.translate(0, 0.28, 0);
    return g;
  }, []);
  const items = useMemo(
    () =>
      layout.flowers.map((f) => ({
        m: new THREE.Matrix4().makeTranslation(f.x, layout.height(f.x, f.z), f.z),
        c: new THREE.Color(FLOWER_COLORS[f.c]),
      })),
    [layout],
  );
  return <Instanced geometry={geo} items={items} castShadow={false} roughness={0.6} />;
}
