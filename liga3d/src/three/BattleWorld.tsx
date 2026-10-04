import { Html } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { PokeType } from '../data/types';
import type { Quality } from '../state/store';
import { runtime } from '../state/world';
import { worldHeight } from './art';
import type { CreatureAnim } from './CreatureModel';
import { PokemonBillboard } from './PokemonBillboard';
import { Avatar } from './world/Avatar';
import { getLayout, resolveCollision, type Layout } from './world/layout';
import { Lights, PostEffects, QUALITY, WorldEnvironment } from './world/Overworld';
import { getSpecies } from '../data/species';

export interface Combatant {
  species: number;
  shiny: boolean;
  anim: CreatureAnim;
  animKey: number;
}

export interface MoveFxState {
  key: number;
  type: PokeType;
  kind: 'projectile' | 'contact' | 'status';
  from: 'player' | 'enemy';
  target: 'player' | 'enemy';
}

export interface Popup {
  key: number;
  side: 'player' | 'enemy';
  text: string;
  tone: 'damage' | 'heal' | 'crit' | 'super' | 'weak' | 'info';
}

export interface BallState {
  key: number;
  color: string;
  shakes: number;
  caught: boolean;
}

export function ballTimeline(shakes: number) {
  const captureAt = 650;
  const landAt = 1250;
  const resultAt = landAt + shakes * 650 + 250;
  return { captureAt, landAt, resultAt, total: resultAt + 600 };
}

export type CameraFocus = 'intro' | 'idle' | 'player' | 'enemy';

/** Battle positions around the spot where the encounter happened. */
export interface Arena {
  layout: Layout;
  trainer: THREE.Vector3;
  mine: THREE.Vector3;
  foe: THREE.Vector3;
  foeTrainer: THREE.Vector3;
  dir: THREE.Vector3;
  side: THREE.Vector3;
  center: THREE.Vector3;
}

function free(layout: Layout, x: number, z: number, r: number): boolean {
  const [nx, nz] = resolveCollision(layout, x, z, r);
  return Math.hypot(nx - x, nz - z) < 0.01;
}

export function makeArena(locId: string): Arena {
  const layout = getLayout(locId);
  const spot = runtime.battleSpot && runtime.battleSpot.loc === locId ? runtime.battleSpot : { x: runtime.player.x, z: runtime.player.z, dir: runtime.player.rot };
  let px = spot.x;
  let pz = spot.z;
  let dirAngle = spot.dir;
  // Find a direction where both Pokémon stand on free ground.
  for (let i = 0; i < 16; i++) {
    const a = spot.dir + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.4;
    const fx = px + Math.sin(a) * 8;
    const fz = pz + Math.cos(a) * 8;
    if (free(layout, fx, fz, 1.6) && free(layout, px + Math.sin(a) * 3, pz + Math.cos(a) * 3, 1)) {
      dirAngle = a;
      break;
    }
    if (i === 15) {
      px *= 0.7;
      pz *= 0.7;
    }
  }
  const dir = new THREE.Vector3(Math.sin(dirAngle), 0, Math.cos(dirAngle));
  const side = new THREE.Vector3(dir.z, 0, -dir.x);
  const at = (v: THREE.Vector3) => v.setY(layout.height(v.x, v.z));
  // `side` points to the left of the screen when looking along `dir`.
  const base = new THREE.Vector3(px, 0, pz);
  const trainer = at(base.clone().addScaledVector(dir, -0.6).addScaledVector(side, -2.3));
  const mine = at(base.clone().addScaledVector(dir, 2.2).addScaledVector(side, 0.9));
  const foe = at(base.clone().addScaledVector(dir, 7.6).addScaledVector(side, -0.9));
  const foeTrainer = at(foe.clone().addScaledVector(dir, 3.2).addScaledVector(side, -1.8));
  const center = mine.clone().lerp(foe, 0.5);
  return { layout, trainer, mine, foe, foeTrainer, dir, side, center };
}

// ——— Camera ———

function BattleCamera({ arena, focus, shake }: { arena: Arena; focus: CameraFocus; shake: number }) {
  const { camera, size } = useThree();
  const t0 = useRef<number | null>(null);
  const shakeStart = useRef({ key: -1, t: 0 });
  const look = useMemo(() => new THREE.Vector3(), []);
  const want = useMemo(() => new THREE.Vector3(), []);
  const lookWant = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }, dt) => {
    if (t0.current === null) t0.current = clock.elapsedTime;
    const t = clock.elapsedTime - t0.current;
    const { dir, side, mine, foe, center } = arena;
    const portrait = size.width < size.height;
    const back = portrait ? 9.5 : 6.5;
    if (focus === 'intro' && t < 2.2) {
      const a = (1 - Math.min(1, t / 2.2)) * 1.4;
      want.copy(foe).addScaledVector(dir, -Math.cos(a) * 5.5).addScaledVector(side, Math.sin(a) * 5.5).setY(foe.y + 1.8 - t * 0.15);
      lookWant.copy(foe).setY(foe.y + 0.9);
    } else if (focus === 'enemy') {
      // Over the shoulder of our Pokémon, looking at the opponent.
      want.copy(mine).addScaledVector(dir, -3.6).addScaledVector(side, 1.4).setY(mine.y + 2.2);
      lookWant.copy(foe).setY(foe.y + 0.9);
    } else if (focus === 'player') {
      want.copy(foe).addScaledVector(dir, 1.2).addScaledVector(side, -2.6).setY(foe.y + 2.4);
      lookWant.copy(mine).setY(mine.y + 0.9);
    } else {
      want.copy(mine).addScaledVector(dir, -back).addScaledVector(side, 1.6).setY(mine.y + (portrait ? 4.6 : 3.3) + Math.sin(t * 0.4) * 0.12);
      want.addScaledVector(side, Math.sin(t * 0.25) * 0.5);
      lookWant.copy(center).setY(center.y + 0.9).addScaledVector(side, portrait ? 0 : -0.8);
    }
    const k = 1 - Math.exp(-dt * (focus === 'intro' ? 6 : 3.2));
    camera.position.lerp(want, k);
    look.lerp(lookWant, k);
    if (shakeStart.current.key !== shake) shakeStart.current = { key: shake, t: clock.elapsedTime };
    const st = clock.elapsedTime - shakeStart.current.t;
    if (shake > 0 && st < 0.35) {
      const amp = 0.12 * (1 - st / 0.35);
      camera.position.x += (Math.random() - 0.5) * amp;
      camera.position.y += (Math.random() - 0.5) * amp;
    }
    camera.lookAt(look);
  });
  return null;
}

// ——— Move effects ———

interface FxStyle {
  colors: string[];
  shape: 'orb' | 'shard' | 'leaf' | 'bolt' | 'ring' | 'smoke' | 'rock';
  motion: 'burst' | 'rise' | 'fall' | 'swirl';
  count: number;
  size: number;
}

const STYLES: Record<PokeType, FxStyle> = {
  fire: { colors: ['#ffd65a', '#ff8a1a', '#ff4a10'], shape: 'orb', motion: 'rise', count: 36, size: 0.26 },
  water: { colors: ['#9fe6ff', '#3fa0ff', '#ffffff'], shape: 'orb', motion: 'burst', count: 34, size: 0.18 },
  grass: { colors: ['#86e05a', '#3fa83a', '#d0f080'], shape: 'leaf', motion: 'swirl', count: 26, size: 0.28 },
  electric: { colors: ['#fff36a', '#ffd000', '#ffffff'], shape: 'bolt', motion: 'burst', count: 22, size: 0.42 },
  ice: { colors: ['#d8f8ff', '#8fe0ff', '#ffffff'], shape: 'shard', motion: 'burst', count: 26, size: 0.26 },
  psychic: { colors: ['#ff7ad0', '#c07aff', '#ffd0f0'], shape: 'ring', motion: 'burst', count: 6, size: 0.6 },
  ghost: { colors: ['#7a5ac0', '#3a2a60', '#b090ff'], shape: 'smoke', motion: 'swirl', count: 22, size: 0.45 },
  dark: { colors: ['#3a2a3a', '#6a4a6a', '#1a1018'], shape: 'smoke', motion: 'burst', count: 22, size: 0.45 },
  poison: { colors: ['#c66ae0', '#8a3aa8', '#e0a0ff'], shape: 'orb', motion: 'rise', count: 28, size: 0.22 },
  ground: { colors: ['#c8a060', '#8a6a40', '#e0c890'], shape: 'rock', motion: 'fall', count: 22, size: 0.3 },
  rock: { colors: ['#a89a7a', '#7a6a50', '#c8b898'], shape: 'rock', motion: 'fall', count: 18, size: 0.4 },
  flying: { colors: ['#ffffff', '#cfe8ff', '#9fd0ff'], shape: 'leaf', motion: 'swirl', count: 22, size: 0.3 },
  fighting: { colors: ['#ffffff', '#ffb070', '#ff7040'], shape: 'shard', motion: 'burst', count: 18, size: 0.32 },
  normal: { colors: ['#ffffff', '#fff2c0', '#e0e0e0'], shape: 'shard', motion: 'burst', count: 16, size: 0.28 },
  bug: { colors: ['#c0e050', '#7aa83a', '#e8f8a0'], shape: 'leaf', motion: 'burst', count: 22, size: 0.22 },
  dragon: { colors: ['#8a7aff', '#4a3ad8', '#d0b0ff'], shape: 'orb', motion: 'swirl', count: 30, size: 0.26 },
  fairy: { colors: ['#ffb0e0', '#ffffff', '#ffd0f0'], shape: 'shard', motion: 'rise', count: 26, size: 0.2 },
  steel: { colors: ['#eef2f8', '#a8b4c4', '#ffffff'], shape: 'shard', motion: 'burst', count: 22, size: 0.26 },
};

const GEOS = {
  orb: new THREE.IcosahedronGeometry(1, 1),
  shard: new THREE.OctahedronGeometry(1, 0),
  leaf: (() => {
    const g = new THREE.PlaneGeometry(1.4, 0.7);
    return g;
  })(),
  bolt: new THREE.BoxGeometry(0.12, 1.6, 0.12),
  ring: new THREE.TorusGeometry(1, 0.08, 6, 32),
  smoke: new THREE.IcosahedronGeometry(1, 2),
  rock: new THREE.DodecahedronGeometry(1, 0),
};

function MoveFx({ fx, arena }: { fx: MoveFxState; arena: Arena }) {
  const style = STYLES[fx.type];
  const mesh = useRef<THREE.InstancedMesh>(null);
  const orb = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const start = useRef<number | null>(null);
  const posOf = (s: 'player' | 'enemy') => (s === 'player' ? arena.mine : arena.foe);
  const from = posOf(fx.from).clone().setY(posOf(fx.from).y + 1.1);
  const to = posOf(fx.target).clone().setY(posOf(fx.target).y + 0.9);
  const parts = useMemo(
    () =>
      Array.from({ length: style.count }, (_, i) => {
        const a = (i / style.count) * Math.PI * 2 + Math.random() * 0.5;
        const up = Math.random();
        return {
          v: new THREE.Vector3(Math.cos(a), style.motion === 'rise' ? 0.6 + up : up * 1.2 - 0.2, Math.sin(a)).normalize().multiplyScalar(2 + Math.random() * 2.5),
          spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
          s: style.size * (0.6 + Math.random() * 0.8),
          c: new THREE.Color(style.colors[i % style.colors.length]),
          phase: Math.random() * Math.PI * 2,
        };
      }),
    [style],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const travel = fx.kind === 'projectile' ? 0.42 : fx.kind === 'contact' ? 0.32 : 0;
  const life = 0.85;
  useFrame(({ clock }) => {
    if (start.current === null) {
      start.current = clock.elapsedTime;
      if (mesh.current) parts.forEach((p, i) => mesh.current!.setColorAt(i, p.c));
      if (mesh.current?.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    }
    const t = clock.elapsedTime - start.current;
    if (orb.current) {
      const p = Math.min(1, t / Math.max(0.01, travel));
      orb.current.visible = fx.kind === 'projectile' && t < travel;
      orb.current.position.lerpVectors(from, to, p);
      orb.current.position.y += Math.sin(p * Math.PI) * 0.8;
      orb.current.scale.setScalar(0.35 + Math.sin(t * 30) * 0.05);
    }
    const bt = t - travel;
    const center = fx.kind === 'status' ? posOf(fx.target).clone().setY(posOf(fx.target).y + 0.2) : to;
    if (light.current) {
      light.current.position.copy(center);
      light.current.intensity = bt > 0 && bt < 0.4 ? 30 * (1 - bt / 0.4) : 0;
    }
    const m = mesh.current;
    if (!m) return;
    m.visible = bt > 0 && bt < life;
    if (!m.visible) return;
    const k = bt / life;
    parts.forEach((p, i) => {
      dummy.position.copy(center);
      if (fx.kind === 'status') {
        const a = p.phase + bt * 4;
        dummy.position.x += Math.cos(a) * 1.1;
        dummy.position.z += Math.sin(a) * 1.1;
        dummy.position.y += bt * 2.2 + (i % 4) * 0.25;
      } else if (style.motion === 'fall') {
        dummy.position.x += p.v.x * 0.35;
        dummy.position.z += p.v.z * 0.35;
        dummy.position.y += 3 - bt * 7 + p.v.y;
        if (dummy.position.y < center.y - 0.6) dummy.position.y = center.y - 0.6;
      } else if (style.motion === 'swirl') {
        const a = p.phase + bt * 7;
        const r = 0.4 + bt * 2.2;
        dummy.position.x += Math.cos(a) * r;
        dummy.position.z += Math.sin(a) * r;
        dummy.position.y += p.v.y * bt * 0.8 + bt * 0.8;
      } else {
        dummy.position.addScaledVector(p.v, bt * (style.motion === 'rise' ? 0.6 : 1));
        if (style.motion === 'rise') dummy.position.y += bt * 2.5;
      }
      dummy.rotation.set(p.spin.x * bt, p.spin.y * bt, p.spin.z * bt);
      const s = style.shape === 'ring' ? p.s * (0.5 + bt * 5) : p.s * (1 - k * 0.7);
      dummy.scale.setScalar(Math.max(0.001, s));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    (m.material as THREE.MeshBasicMaterial).opacity = 1 - k;
  });
  return (
    <group>
      <mesh ref={orb} visible={false}>
        <icosahedronGeometry args={[1, 2]} />
        <meshBasicMaterial color={style.colors[0]} toneMapped={false} />
      </mesh>
      <instancedMesh ref={mesh} args={[GEOS[style.shape], undefined, style.count]} frustumCulled={false} visible={false}>
        <meshBasicMaterial transparent toneMapped={false} side={THREE.DoubleSide} blending={style.shape === 'smoke' || style.shape === 'rock' ? THREE.NormalBlending : THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
      <pointLight ref={light} color={style.colors[0]} intensity={0} distance={8} />
    </group>
  );
}

// ——— Ball ———

function PokeBall({ ball, arena }: { ball: BallState; arena: Arena }) {
  const ref = useRef<THREE.Group>(null);
  const flash = useRef<THREE.PointLight>(null);
  const stars = useRef<THREE.Group>(null);
  const start = useRef<number | null>(null);
  const tl = ballTimeline(ball.shakes);
  const from = arena.trainer.clone().setY(arena.trainer.y + 1.6);
  const top = arena.foe.clone().setY(arena.foe.y + 2.2).addScaledVector(arena.dir, -0.6);
  const ground = arena.foe.clone().setY(arena.foe.y + 0.22).addScaledVector(arena.dir, -0.6);
  useFrame(({ clock }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    const ms = (clock.elapsedTime - start.current) * 1000;
    const g = ref.current;
    if (!g) return;
    g.visible = true;
    g.rotation.set(0, 0, 0);
    if (ms < tl.captureAt) {
      const p = ms / tl.captureAt;
      g.position.lerpVectors(from, top, p);
      g.position.y += Math.sin(p * Math.PI) * 2.2;
      g.rotation.x = -p * 14;
    } else if (ms < tl.landAt) {
      const p = (ms - tl.captureAt) / (tl.landAt - tl.captureAt);
      g.position.lerpVectors(top, ground, p * p);
    } else if (ms < tl.resultAt) {
      g.position.copy(ground);
      const local = (ms - tl.landAt) % 650;
      const inShake = ms - tl.landAt < ball.shakes * 650;
      g.rotation.z = inShake && local < 380 ? Math.sin((local / 380) * Math.PI * 2) * 0.5 : 0;
    } else {
      g.position.copy(ground);
      g.visible = ball.caught;
    }
    if (flash.current) flash.current.intensity = ms > tl.captureAt && ms < tl.captureAt + 350 ? 40 : 0;
    if (stars.current) {
      const st = ms - tl.resultAt;
      stars.current.visible = ball.caught && st > 0 && st < 1200;
      stars.current.children.forEach((c, i) => {
        const a = (i / 6) * Math.PI * 2;
        c.position.set(Math.cos(a) * st * 0.0015, 0.4 + Math.sin(a) * st * 0.001 + st * 0.0008, 0);
        c.rotation.z = st * 0.01;
      });
    }
  });
  return (
    <>
      <group ref={ref} visible={false} scale={0.32}>
        <mesh castShadow>
          <sphereGeometry args={[0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={ball.color} roughness={0.3} metalness={0.1} />
        </mesh>
        <mesh rotation={[Math.PI, 0, 0]} castShadow>
          <sphereGeometry args={[0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#f5f5f5" roughness={0.3} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.5, 0.045, 8, 32]} />
          <meshStandardMaterial color="#202020" />
        </mesh>
        <mesh position={[0, 0, 0.48]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.13, 0.13, 0.08, 16]} />
          <meshStandardMaterial color="#fafafa" emissive="#ffffff" emissiveIntensity={0.3} />
        </mesh>
        <pointLight ref={flash} color="#ff5050" intensity={0} distance={6} />
      </group>
      <group ref={stars} position={ground.toArray()} visible={false}>
        {Array.from({ length: 6 }, (_, i) => (
          <mesh key={i}>
            <octahedronGeometry args={[0.12, 0]} />
            <meshBasicMaterial color="#ffe14a" toneMapped={false} />
          </mesh>
        ))}
      </group>
    </>
  );
}

function PopupLabel({ popup, arena }: { popup: Popup; arena: Arena }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const pos = popup.side === 'player' ? arena.mine : arena.foe;
  useFrame(({ clock }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    const t = clock.elapsedTime - start.current;
    if (ref.current) {
      ref.current.style.transform = `translateY(${-t * 40}px) scale(${t < 0.15 ? 0.6 + t * 2.7 : 1})`;
      ref.current.style.opacity = String(Math.max(0, 1 - Math.max(0, t - 0.6) * 2));
    }
  });
  return (
    <Html position={[pos.x, pos.y + 2.4, pos.z]} center zIndexRange={[6, 0]}>
      <div ref={ref} className={`dmg-popup ${popup.tone}`}>
        {popup.text}
      </div>
    </Html>
  );
}

export interface BattleWorldProps {
  locId: string;
  arena: Arena;
  quality: Quality;
  player: Combatant | null;
  enemy: Combatant | null;
  trainerBattle: boolean;
  fx: MoveFxState | null;
  ball: BallState | null;
  popups: Popup[];
  focus: CameraFocus;
  shake: number;
}

export function BattleWorld({ arena, quality, player, enemy, trainerBattle, fx, ball, popups, focus, shake }: BattleWorldProps) {
  const q = QUALITY[quality];
  const clear = useMemo(() => ({ x: arena.center.x, z: arena.center.z, r: 7.5 }), [arena]);
  const center = useMemo<() => [number, number]>(() => () => [arena.center.x, arena.center.z], [arena]);
  const playerYaw = Math.atan2(arena.dir.x, arena.dir.z);
  const mineH = player ? worldHeight(getSpecies(player.species).height, 1.1) : 1;
  return (
    <Canvas shadows={q.shadows ? 'soft' : false} dpr={q.dpr} flat={q.post} camera={{ fov: 45, near: 0.1, far: 900 }} gl={{ antialias: !q.post, preserveDrawingBuffer: true }}>
      <WorldEnvironment layout={arena.layout} quality={quality} clear={clear} />
      <Lights layout={arena.layout} quality={quality} center={center} />
      <group position={arena.trainer} rotation={[0, playerYaw, 0]}>
        <Avatar />
      </group>
      {trainerBattle && (
        <group position={arena.foeTrainer} rotation={[0, playerYaw + Math.PI, 0]}>
          <Avatar colors={{ shirt: '#4f86d8', pants: '#2a2a3a', cap: '#2a6bc5', bag: '#e8473a', skin: '#f3cfae', hair: '#2a1a12' }} />
        </group>
      )}
      {enemy && (
        <group position={arena.foe}>
          <PokemonBillboard speciesId={enemy.species} shiny={enemy.shiny} anim={enemy.anim} animKey={enemy.animKey} minHeight={1.1} />
        </group>
      )}
      {player && (
        <group position={arena.mine} rotation={[0, playerYaw, 0]}>
          <PokemonBillboard speciesId={player.species} shiny={player.shiny} anim={player.anim} animKey={player.animKey} minHeight={1.1} flip />
          <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[Math.max(0.6, mineH * 0.32), Math.max(0.7, mineH * 0.32) + 0.08, 40]} />
            <meshBasicMaterial color="#5fd0ff" transparent opacity={0.55} depthWrite={false} />
          </mesh>
        </group>
      )}
      {fx && <MoveFx key={fx.key} fx={fx} arena={arena} />}
      {ball && <PokeBall key={ball.key} ball={ball} arena={arena} />}
      {popups.map((p) => (
        <PopupLabel key={p.key} popup={p} arena={arena} />
      ))}
      <BattleCamera arena={arena} focus={focus} shake={shake} />
      <PostEffects quality={quality} />
    </Canvas>
  );
}
