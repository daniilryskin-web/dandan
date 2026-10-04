import { Html } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, HueSaturation, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { getItem } from '../../data/items';
import { getSpecies } from '../../data/species';
import { getLocation, type Encounter } from '../../data/world';
import { SHINY_CHANCE } from '../../engine/pokemon';
import { pickWeighted, randInt } from '../../engine/rng';
import type { Quality } from '../../state/store';
import { input, runtime, useWorld, type Pickup, type Prompt, type Spawn } from '../../state/world';
import { worldHeight } from '../art';
import { PokemonBillboard } from '../PokemonBillboard';
import { Building as Tower, Crystal, Gym, House, Pokecenter, Pylon, Shop, Sparks, Volcano } from '../Props';
import { Avatar, type AvatarColors } from './Avatar';
import { Flowers, Rocks, Trees } from './Foliage';
import { Grass, type ClearArea } from './Grass';
import { arrivalPoint, getLayout, resolveCollision, spawnPoint, WORLD_R, type Layout } from './layout';
import { Clouds, SKIES, SkyDome, SUN_DIR } from './Sky';
import { Terrain } from './Terrain';
import { WaterDisc } from './Water';

export interface OverworldHandlers {
  onEncounter: (s: Spawn) => void;
  onGate: (to: string) => void;
  onPickup: (p: Pickup) => void;
  promptAt: (x: number, z: number, layout: Layout) => Prompt | null;
  trainerDone: (id: string) => boolean;
}

export const QUALITY: Record<Quality, { dpr: [number, number]; grass: number; shadows: boolean; shadowSize: number; post: boolean; ao: boolean; segments: number }> = {
  high: { dpr: [1, 2], grass: 1, shadows: true, shadowSize: 2048, post: true, ao: true, segments: 180 },
  medium: { dpr: [1, 1.5], grass: 0.45, shadows: true, shadowSize: 1024, post: true, ao: false, segments: 130 },
  low: { dpr: [0.75, 1], grass: 0.15, shadows: false, shadowSize: 512, post: false, ao: false, segments: 90 },
};

// ——— Camera & input ———

function CameraRig({ layout }: { layout: Layout }) {
  const { camera, gl } = useThree();
  const target = useMemo(() => new THREE.Vector3(), []);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number; moved: boolean; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!down || down.id !== e.pointerId) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) > 6) down.moved = true;
      if (down.moved) {
        runtime.cameraYaw -= dx * 0.006;
        runtime.cameraPitch = Math.max(0.12, Math.min(1.25, runtime.cameraPitch + dy * 0.004));
        down.x = e.clientX;
        down.y = e.clientY;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (down && !down.moved && runtime.terrain) {
        const rect = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObject(runtime.terrain, false)[0];
        if (hit) input.target = [hit.point.x, hit.point.z];
      }
      down = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      runtime.cameraDist = Math.max(5, Math.min(22, runtime.cameraDist + e.deltaY * 0.01));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl, camera, ray]);

  useFrame((_, dt) => {
    const p = runtime.player;
    const y = layout.height(p.x, p.z);
    target.set(p.x, y + 1.3, p.z);
    const d = runtime.cameraDist;
    const want = new THREE.Vector3(
      p.x + Math.sin(runtime.cameraYaw) * Math.cos(runtime.cameraPitch) * d,
      y + 1.3 + Math.sin(runtime.cameraPitch) * d,
      p.z + Math.cos(runtime.cameraYaw) * Math.cos(runtime.cameraPitch) * d,
    );
    // Pull the camera in front of trees, buildings and hills that would hide the player.
    const steps = 24;
    const probe = new THREE.Vector3();
    for (let i = 1; i <= steps; i++) {
      probe.lerpVectors(target, want, i / steps);
      if (blocked(layout, probe)) {
        want.lerpVectors(target, want, Math.max(0.15, (i - 1) / steps));
        break;
      }
    }
    const ground = layout.height(want.x, want.z) + 0.8;
    if (want.y < ground) want.y = ground;
    camera.position.lerp(want, 1 - Math.exp(-dt * 8));
    camera.lookAt(target);
  });
  return null;
}

function blocked(layout: Layout, p: THREE.Vector3): boolean {
  if (p.y < layout.height(p.x, p.z) + 0.4) return true;
  for (const t of layout.trees) {
    const r = (t.kind === 'pine' ? 1.6 : 2.2) * t.s;
    const top = layout.height(t.x, t.z) + (t.kind === 'pine' ? 5.6 : 4.6) * t.s;
    if (p.y < top && Math.hypot(p.x - t.x, p.z - t.z) < r) return true;
  }
  for (const b of layout.buildings) {
    if (p.y < layout.height(b.x, b.z) + 4.5 && Math.hypot(p.x - b.x, p.z - b.z) < (b.kind === 'gym' ? 3.4 : 2.8)) return true;
  }
  return false;
}

function KeyboardInput() {
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'ц', 'ф', 'ы', 'в', 'shift'].includes(k)) {
        input.keys.add(k);
        input.target = null;
        if (k.startsWith('arrow')) e.preventDefault();
      }
      if (k === 'e' || k === 'у' || k === 'enter') input.interact = true;
    };
    const up = (e: KeyboardEvent) => input.keys.delete(e.key.toLowerCase());
    const blur = () => input.keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return null;
}

// ——— Player ———

function Player({ layout, handlers }: { layout: Layout; handlers: OverworldHandlers }) {
  const ref = useRef<THREE.Group>(null);
  const marker = useRef<THREE.Mesh>(null);
  const promptTimer = useRef(0);
  const setPrompt = useWorld((s) => s.setPrompt);
  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    const p = runtime.player;
    const k = input.keys;
    let ix = (k.has('d') || k.has('в') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('ф') || k.has('arrowleft') ? 1 : 0) + input.joy.x;
    let iz = (k.has('s') || k.has('ы') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('ц') || k.has('arrowup') ? 1 : 0) + input.joy.y;
    let mx = 0;
    let mz = 0;
    if (Math.hypot(ix, iz) > 0.05) {
      const len = Math.max(1, Math.hypot(ix, iz));
      ix /= len;
      iz /= len;
      const yaw = runtime.cameraYaw;
      mx = ix * Math.cos(yaw) + iz * Math.sin(yaw);
      mz = -ix * Math.sin(yaw) + iz * Math.cos(yaw);
    } else if (input.target) {
      const dx = input.target[0] - p.x;
      const dz = input.target[1] - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3) input.target = null;
      else {
        mx = dx / d;
        mz = dz / d;
      }
    }
    const walking = k.has('shift');
    const top = runtime.lock ? 0 : walking ? 3 : 7;
    const want = Math.hypot(mx, mz) > 0 ? top : 0;
    p.speed += (want - p.speed) * (1 - Math.exp(-dt * 10));
    if (p.speed > 0.05 && Math.hypot(mx, mz) > 0) {
      const [nx, nz] = resolveCollision(layout, p.x + mx * p.speed * dt, p.z + mz * p.speed * dt, 0.45);
      p.x = nx;
      p.z = nz;
      const targetRot = Math.atan2(mx, mz);
      p.rot += Math.atan2(Math.sin(targetRot - p.rot), Math.cos(targetRot - p.rot)) * (1 - Math.exp(-dt * 12));
    }
    const g = ref.current;
    if (g) {
      g.position.set(p.x, layout.height(p.x, p.z), p.z);
      g.rotation.y = p.rot;
    }
    if (marker.current) {
      marker.current.visible = !!input.target;
      if (input.target) {
        marker.current.position.set(input.target[0], layout.height(input.target[0], input.target[1]) + 0.06, input.target[1]);
        marker.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 6) * 0.15);
      }
    }
    if (runtime.lock) return;

    // Contacts.
    for (const gate of layout.gates) {
      if (Math.hypot(p.x - gate.x, p.z - gate.z) < 2.4) {
        runtime.lock = true;
        input.target = null;
        handlers.onGate(gate.to);
        return;
      }
    }
    for (const s of runtime.spawns.values()) {
      const r = 0.7 + Math.min(1.6, getSpecies(s.species).height * 0.35);
      if (Math.hypot(p.x - s.x, p.z - s.z) < r && clock.elapsedTime - s.bornAt > 0.8) {
        runtime.lock = true;
        input.target = null;
        handlers.onEncounter(s);
        return;
      }
    }
    for (const it of runtime.pickups.values()) {
      if (Math.hypot(p.x - it.x, p.z - it.z) < 1.3) {
        runtime.pickups.delete(it.id);
        useWorld.getState().syncPickups();
        handlers.onPickup(it);
        break;
      }
    }
    promptTimer.current -= dt;
    if (promptTimer.current <= 0) {
      promptTimer.current = 0.15;
      setPrompt(handlers.promptAt(p.x, p.z, layout));
    }
  });
  return (
    <>
      <group ref={ref}>
        <Avatar getSpeed={() => runtime.player.speed} />
      </group>
      <mesh ref={marker} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.35, 0.5, 24]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} />
      </mesh>
    </>
  );
}

// ——— Wild Pokémon ———

function SpawnManager({ layout }: { layout: Layout }) {
  const sync = useWorld((s) => s.syncSpawns);
  const timer = useRef(0);
  const wild = layout.loc.wild ?? [];
  const target = { meadow: 9, forest: 8, hills: 9, lake: 8, mountain: 7, cave: 7, volcano: 7, plant: 7, town: 0 }[layout.biome];
  useFrame(({ clock }, dt) => {
    timer.current -= dt;
    if (timer.current > 0 || !wild.length) return;
    timer.current = 0.6;
    if (runtime.spawns.size >= target) return;
    const enc: Encounter = pickWeighted(Math.random, wild);
    const sp = getSpecies(enc.species);
    const water = sp.types.includes('water');
    const pt = spawnPoint(layout, Math.random, [runtime.player.x, runtime.player.z], water);
    if (!pt) return;
    const id = runtime.nextId++;
    runtime.spawns.set(id, {
      id,
      species: enc.species,
      level: randInt(Math.random, enc.min, enc.max),
      shiny: Math.random() < SHINY_CHANCE,
      x: pt.x,
      z: pt.z,
      homeX: pt.x,
      homeZ: pt.z,
      tx: pt.x,
      tz: pt.z,
      wait: Math.random() * 2,
      heading: Math.random() * 6.28,
      inWater: pt.inWater,
      bold: Math.random() < 0.35,
      bornAt: clock.elapsedTime,
    });
    sync();
  });
  return null;
}

function WildSpawn({ id, layout }: { id: number; layout: Layout }) {
  const ref = useRef<THREE.Group>(null);
  const tag = useRef<HTMLDivElement>(null);
  const s = runtime.spawns.get(id);
  useFrame((_, rawDt) => {
    const sp = runtime.spawns.get(id);
    const g = ref.current;
    if (!sp || !g) return;
    const dt = Math.min(0.05, rawDt);
    const p = runtime.player;
    const dp = Math.hypot(p.x - sp.x, p.z - sp.z);
    let speed = 1.2;
    if (sp.bold && dp < 9 && !runtime.lock) {
      sp.tx = p.x;
      sp.tz = p.z;
      speed = 2.4;
    } else if (sp.wait > 0) {
      sp.wait -= dt;
      speed = 0;
    } else if (Math.hypot(sp.tx - sp.x, sp.tz - sp.z) < 0.2) {
      sp.wait = 1 + Math.random() * 3;
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * (sp.inWater ? 3 : 5);
      sp.tx = sp.homeX + Math.cos(a) * r;
      sp.tz = sp.homeZ + Math.sin(a) * r;
      speed = 0;
    }
    if (speed > 0) {
      const dx = sp.tx - sp.x;
      const dz = sp.tz - sp.z;
      const d = Math.hypot(dx, dz) || 1;
      let nx = sp.x + (dx / d) * speed * dt;
      let nz = sp.z + (dz / d) * speed * dt;
      if (!sp.inWater) [nx, nz] = resolveCollision(layout, nx, nz, 0.5);
      sp.x = nx;
      sp.z = nz;
    }
    const lake = sp.inWater ? layout.lakes.find((l) => Math.hypot(sp.x - l.x, sp.z - l.z) < l.r + 1) : null;
    const y = lake ? waterLevel(layout, lake) - 0.25 : layout.height(sp.x, sp.z);
    g.position.set(sp.x, y, sp.z);
    if (tag.current) tag.current.style.opacity = dp < 7 ? '1' : '0';
  });
  if (!s) return null;
  const sp = getSpecies(s.species);
  return (
    <group ref={ref} position={[s.x, layout.height(s.x, s.z), s.z]}>
      <PokemonBillboard speciesId={s.species} shiny={s.shiny} bobSeed={id} />
      <Html position={[0, worldHeight(sp.height) + 0.5, 0]} center distanceFactor={9} zIndexRange={[4, 0]}>
        <div ref={tag} className={`world-label wild${s.shiny ? ' shiny' : ''}`} style={{ opacity: 0 }}>
          {s.shiny ? '✦ ' : ''}
          {sp.name} <small>ур. {s.level}</small>
        </div>
      </Html>
    </group>
  );
}

function waterLevel(layout: Layout, l: { x: number; z: number; r: number }): number {
  return layout.height(l.x + l.r + 1.5, l.z) - 0.35;
}

function Spawns({ layout }: { layout: Layout }) {
  const ids = useWorld((s) => s.spawnIds);
  return (
    <>
      {ids.map((id) => (
        <WildSpawn key={id} id={id} layout={layout} />
      ))}
    </>
  );
}

// ——— Landmarks ———

function Gates({ layout }: { layout: Layout }) {
  return (
    <>
      {layout.gates.map((g) => {
        const dest = getLocation(g.to);
        const y = layout.height(g.x, g.z);
        return (
          <group key={g.to} position={[g.x, y, g.z]} rotation={[0, -g.angle + Math.PI / 2, 0]}>
            {[-1.9, 1.9].map((x) => (
              <mesh key={x} position={[x, 1.6, 0]} castShadow>
                <cylinderGeometry args={[0.22, 0.28, 3.2, 10]} />
                <meshStandardMaterial color="#f4f1ea" roughness={0.5} />
              </mesh>
            ))}
            <mesh position={[0, 3.3, 0]} castShadow>
              <boxGeometry args={[4.6, 0.4, 0.5]} />
              <meshStandardMaterial color="#e8473a" roughness={0.5} />
            </mesh>
            <mesh position={[0, 1.6, 0]}>
              <planeGeometry args={[3.4, 3]} />
              <meshBasicMaterial color="#9fe3ff" transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Html position={[0, 4.2, 0]} center distanceFactor={7} zIndexRange={[5, 0]}>
              <div className="world-label gate">→ {dest.name}</div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

function Buildings({ layout }: { layout: Layout }) {
  return (
    <>
      {layout.buildings.map((b, i) => {
        const y = layout.height(b.x, b.z);
        const pos: [number, number, number] = [b.x, y, b.z];
        if (b.kind === 'pokecenter') return <Pokecenter key={i} position={pos} rotation={b.rot} />;
        if (b.kind === 'shop') return <Shop key={i} position={pos} rotation={b.rot} />;
        if (b.kind === 'gym') return <Gym key={i} position={pos} rotation={b.rot} />;
        return <House key={i} position={pos} rotation={b.rot} roof={b.roof} />;
      })}
    </>
  );
}

const TRAINER_COLORS: AvatarColors[] = [
  { shirt: '#4f86d8', pants: '#3a3a44', cap: '#2a6bc5', bag: '#e8473a', skin: '#f3cfae', hair: '#2a1a12' },
  { shirt: '#5fb06a', pants: '#6a4a2a', cap: '#3a7a3a', bag: '#c89a3a', skin: '#e8b890', hair: '#6a3a1a' },
  { shirt: '#e86a9a', pants: '#3a3a6a', cap: '#ffffff', bag: '#8a5fc0', skin: '#f6d6be', hair: '#c8803a' },
  { shirt: '#f2a03a', pants: '#2c3e50', cap: '#f2a03a', bag: '#3a3a44', skin: '#d8a070', hair: '#1a1a1a' },
];

function Trainers({ layout, done }: { layout: Layout; done: (id: string) => boolean }) {
  return (
    <>
      {layout.trainers.map((t, i) => {
        const defeated = done(t.id);
        return (
          <group key={t.id} position={[t.x, layout.height(t.x, t.z), t.z]} rotation={[0, t.rot, 0]}>
            <Avatar colors={t.gym ? { shirt: '#7a6a5a', pants: '#3a2a1a', cap: '#ffd54f', bag: '#7a6a5a', skin: '#f0c8a0', hair: '#3a2a1a' } : TRAINER_COLORS[i % TRAINER_COLORS.length]} wave={!defeated} />
            {!defeated && (
              <Html position={[0, 2.35, 0]} center distanceFactor={12} zIndexRange={[5, 0]}>
                <div className={`world-label trainer${t.gym ? ' gym' : ''}`}>{t.gym ? '★' : '!'}</div>
              </Html>
            )}
          </group>
        );
      })}
    </>
  );
}

function PickupItem({ id, layout }: { id: number; layout: Layout }) {
  const ref = useRef<THREE.Group>(null);
  const it = runtime.pickups.get(id);
  useFrame(({ clock }) => {
    if (!ref.current || !it) return;
    ref.current.position.y = layout.height(it.x, it.z) + 0.35 + Math.sin(clock.elapsedTime * 2.5 + id) * 0.08;
    ref.current.rotation.y = clock.elapsedTime * 1.5;
  });
  if (!it) return null;
  const rare = getItem(it.item).price >= 2000 || it.item === 'master-ball';
  return (
    <group ref={ref} position={[it.x, 0, it.z]}>
      <mesh castShadow>
        <sphereGeometry args={[0.22, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={rare ? '#ffd54f' : '#e8473a'} roughness={0.3} />
      </mesh>
      <mesh rotation={[Math.PI, 0, 0]}>
        <sphereGeometry args={[0.22, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#f5f5f5" roughness={0.3} />
      </mesh>
      <pointLight color={rare ? '#ffe680' : '#ffd0c0'} intensity={3} distance={3} />
    </group>
  );
}

function Pickups({ layout }: { layout: Layout }) {
  const ids = useWorld((s) => s.pickupIds);
  return (
    <>
      {ids.map((id) => (
        <PickupItem key={id} id={id} layout={layout} />
      ))}
    </>
  );
}

function Fountain({ y }: { y: number }) {
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2.7, 2.9, 0.6, 40, 1, true]} />
        <meshStandardMaterial color="#e9e4d8" roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.62, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.45, 2.75, 40]} />
        <meshStandardMaterial color="#f4f0e6" roughness={0.6} />
      </mesh>
      <WaterDisc x={0} z={0} r={2.5} y={y + 0.48} />
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.35, 0.55, 1.4, 20]} />
        <meshStandardMaterial color="#e9e4d8" roughness={0.6} />
      </mesh>
      <mesh position={[0, 1.85, 0]}>
        <sphereGeometry args={[0.55, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#8fd8ff" transparent opacity={0.7} roughness={0.1} />
      </mesh>
    </group>
  );
}

function BiomeExtras({ layout }: { layout: Layout }) {
  const h = layout.height;
  if (layout.biome === 'town') return <Fountain y={h(0, 0)} />;
  if (layout.biome === 'volcano') return <Volcano position={[18, h(18, -55) - 2, -55]} />;
  if (layout.biome === 'cave') {
    return (
      <>
        {[[8, 6], [-10, 12], [14, -14], [-16, -8], [22, 10], [-4, -22], [-24, 18], [26, -4]].map(([x, z], i) => (
          <Crystal key={i} position={[x, h(x, z), z]} scale={1.2 + (i % 3) * 0.4} color={i % 2 ? '#8a6aff' : '#4ac8ff'} />
        ))}
      </>
    );
  }
  if (layout.biome === 'plant') {
    return (
      <>
        <Tower position={[-24, h(-24, -22), -22]} rotation={0.6} scale={1.6} />
        <Tower position={[26, h(26, -18), -18]} rotation={-0.5} scale={1.3} />
        {[[-14, 16], [16, 20], [30, 8], [-30, 4]].map(([x, z], i) => (
          <group key={i}>
            <Pylon position={[x, h(x, z), z]} rotation={i} />
            <Sparks position={[x, h(x, z) + 4.6, z]} />
          </group>
        ))}
      </>
    );
  }
  return null;
}

// ——— Lights & post ———

export function Lights({ layout, quality, center }: { layout: Layout; quality: Quality; center?: () => [number, number] }) {
  const sky = SKIES[layout.biome];
  const sun = useRef<THREE.DirectionalLight>(null);
  const torch = useRef<THREE.PointLight>(null);
  const q = QUALITY[quality];
  useFrame(() => {
    const [px, pz] = center ? center() : [runtime.player.x, runtime.player.z];
    const y = layout.height(px, pz);
    if (sun.current) {
      sun.current.position.set(px + SUN_DIR.x * 40, y + SUN_DIR.y * 40, pz + SUN_DIR.z * 40);
      sun.current.target.position.set(px, y, pz);
      sun.current.target.updateMatrixWorld();
    }
    if (torch.current) torch.current.position.set(px, y + 3, pz);
  });
  return (
    <>
      <hemisphereLight args={[sky.hemiSky, sky.hemiGround, sky.ambient + 0.45]} />
      <ambientLight intensity={sky.ambient * 0.35} />
      <directionalLight
        ref={sun}
        intensity={sky.sunIntensity}
        color={sky.sun}
        castShadow={q.shadows}
        shadow-mapSize-width={q.shadowSize}
        shadow-mapSize-height={q.shadowSize}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-camera-near={1}
        shadow-camera-far={120}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />
      {layout.biome === 'cave' && <pointLight ref={torch} color="#ffd9a0" intensity={40} distance={22} decay={1.4} />}
    </>
  );
}

export function PostEffects({ quality }: { quality: Quality }) {
  const q = QUALITY[quality];
  if (!q.post) return null;
  const effects = [
    q.ao ? <N8AO key="ao" aoRadius={1.6} intensity={1.6} distanceFalloff={1} halfRes /> : null,
    <Bloom key="bloom" luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={0.45} mipmapBlur />,
    <HueSaturation key="sat" saturation={0.12} />,
    <ToneMapping key="tm" mode={ToneMappingMode.ACES_FILMIC} />,
    <Vignette key="vig" offset={0.25} darkness={0.42} />,
    <SMAA key="smaa" />,
  ].filter((x): x is JSX.Element => x !== null);
  return <EffectComposer multisampling={0}>{effects}</EffectComposer>;
}

export function WorldEnvironment({ layout, quality, clear }: { layout: Layout; quality: Quality; clear?: ClearArea }) {
  const sky = SKIES[layout.biome];
  const q = QUALITY[quality];
  return (
    <>
      <SkyDome biome={layout.biome} />
      {sky.clouds > 0 && <Clouds count={Math.round(sky.clouds * (quality === 'low' ? 0.5 : 1))} seed={layout.seed} />}
      <fog attach="fog" args={[sky.fog, sky.fogNear, sky.fogFar]} />
      <group
        ref={(o) => {
          runtime.terrain = o?.children[0] ?? null;
        }}
      >
        <Terrain layout={layout} segments={q.segments} />
      </group>
      <Grass layout={layout} density={q.grass} clear={clear} />
      <Trees layout={layout} />
      <Rocks layout={layout} />
      <Flowers layout={layout} />
      {layout.lakes.map((l, i) => (
        <WaterDisc key={`l${i}`} x={l.x} z={l.z} r={l.r + 2.2} y={waterLevel(layout, l)} />
      ))}
      {layout.lava.map((l, i) => (
        <WaterDisc key={`v${i}`} x={l.x} z={l.z} r={l.r + 1} y={layout.height(l.x + l.r + 1.2, l.z) - 0.3} lava />
      ))}
      <Buildings layout={layout} />
      <BiomeExtras layout={layout} />
    </>
  );
}

export function Overworld({ locId, quality, handlers }: { locId: string; quality: Quality; handlers: OverworldHandlers }) {
  const layout = getLayout(locId);
  const q = QUALITY[quality];
  const syncPickups = useWorld((s) => s.syncPickups);
  const syncSpawns = useWorld((s) => s.syncSpawns);

  // Entering a new location: place the player at the gate and scatter items.
  useEffect(() => {
    if (runtime.loc === locId) {
      syncSpawns();
      syncPickups();
      return;
    }
    const from = runtime.loc || null;
    runtime.loc = locId;
    runtime.spawns.clear();
    runtime.pickups.clear();
    runtime.lock = false;
    input.target = null;
    const [x, z] = arrivalPoint(layout, from);
    runtime.player.x = x;
    runtime.player.z = z;
    runtime.player.speed = 0;
    runtime.player.rot = Math.atan2(-x, -z);
    runtime.cameraYaw = Math.atan2(x, z);
    const loot = layout.loc.loot ?? [];
    for (let i = 0; i < Math.min(4, loot.length + 1) && loot.length; i++) {
      const pt = spawnPoint(layout, Math.random, [x, z], false);
      if (!pt) continue;
      const id = runtime.nextId++;
      runtime.pickups.set(id, { id, item: pickWeighted(Math.random, loot).item, x: pt.x, z: pt.z });
    }
    syncSpawns();
    syncPickups();
  }, [locId, layout, syncPickups, syncSpawns]);

  return (
    <Canvas
      shadows={q.shadows ? 'soft' : false}
      dpr={q.dpr}
      flat={q.post}
      camera={{ fov: 50, near: 0.1, far: 900, position: [0, 8, 14] }}
      gl={{ antialias: !q.post, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
    >
      <WorldEnvironment layout={layout} quality={quality} />
      <Lights layout={layout} quality={quality} />
      <Gates layout={layout} />
      <Trainers layout={layout} done={handlers.trainerDone} />
      <Pickups layout={layout} />
      <Spawns layout={layout} />
      <SpawnManager layout={layout} />
      <Player layout={layout} handlers={handlers} />
      <CameraRig layout={layout} />
      <KeyboardInput />
      <PostEffects quality={quality} />
    </Canvas>
  );
}

export { WORLD_R };
