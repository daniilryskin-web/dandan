import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Biome } from '../data/world';
import { BIOME_LOOKS } from './biomes';
import { CreatureModel, type CreatureAnim } from './CreatureModel';
import { Environment } from './Environment';

export const ENEMY_POS = new THREE.Vector3(2.1, 0, -2.6);
export const PLAYER_POS = new THREE.Vector3(-1.7, 0, 1.7);
const ENEMY_YAW = Math.atan2(PLAYER_POS.x - ENEMY_POS.x, PLAYER_POS.z - ENEMY_POS.z);
const PLAYER_YAW = Math.atan2(ENEMY_POS.x - PLAYER_POS.x, ENEMY_POS.z - PLAYER_POS.z);

export interface Combatant {
  species: number;
  shiny: boolean;
  anim: CreatureAnim;
  animKey: number;
}

export interface FxState {
  key: number;
  kind: 'projectile' | 'burst' | 'aura';
  from: 'player' | 'enemy';
  /** Who receives the effect (projectile/burst land on the target; aura plays on the target). */
  target: 'player' | 'enemy';
  color: string;
}

export interface BallState {
  key: number;
  color: string;
  shakes: number;
  caught: boolean;
}

/** Ball animation timings in ms, shared with the UI that sequences the battle. */
export function ballTimeline(shakes: number) {
  const captureAt = 550;
  const landAt = 1150;
  const resultAt = landAt + shakes * 600 + 250;
  return { captureAt, landAt, resultAt, total: resultAt + 600 };
}

function Platform({ position, radius, color }: { position: THREE.Vector3; radius: number; color: string }) {
  const ring = useMemo(() => new THREE.Color(color).offsetHSL(0, 0, 0.12).getStyle(), [color]);
  return (
    <group position={[position.x, 0.02, position.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[radius, 32]} />
        <meshStandardMaterial color={color} roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[radius * 0.86, radius, 40]} />
        <meshStandardMaterial color={ring} roughness={1} />
      </mesh>
    </group>
  );
}

function posOf(side: 'player' | 'enemy') {
  return side === 'player' ? PLAYER_POS : ENEMY_POS;
}

function Effect({ fx }: { fx: FxState }) {
  const group = useRef<THREE.Group>(null);
  const start = useRef<number | null>(null);
  const from = posOf(fx.from).clone().add(new THREE.Vector3(0, 0.9, 0));
  const to = posOf(fx.target).clone().add(new THREE.Vector3(0, 0.8, 0));
  const dirs = useMemo(
    () => Array.from({ length: 12 }, (_, i) => new THREE.Vector3(Math.cos(i * 2.4), 0.4 + ((i * 7) % 5) / 6, Math.sin(i * 2.4)).normalize()),
    [],
  );
  useFrame(({ clock }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    const t = clock.elapsedTime - start.current;
    const g = group.current;
    if (!g) return;
    const ball = g.getObjectByName('orb');
    const burst = g.getObjectByName('burst');
    const aura = g.getObjectByName('aura');
    const travel = fx.kind === 'projectile' ? 0.35 : 0;
    if (ball) {
      const p = Math.min(1, t / 0.35);
      ball.visible = fx.kind === 'projectile' && t < travel;
      ball.position.lerpVectors(from, to, p);
      ball.position.y += Math.sin(p * Math.PI) * 0.6;
    }
    if (burst) {
      const bt = t - travel;
      burst.visible = fx.kind !== 'aura' && bt >= 0 && bt < 0.55;
      burst.position.copy(to);
      burst.children.forEach((c, i) => {
        const d = dirs[i % dirs.length];
        c.position.copy(d).multiplyScalar(Math.max(0, bt) * 2.4);
        c.scale.setScalar(Math.max(0.01, 1 - bt / 0.55));
      });
    }
    if (aura) {
      aura.visible = fx.kind === 'aura' && t < 0.9;
      aura.position.copy(posOf(fx.target));
      aura.children.forEach((c, i) => {
        const a = (i / aura.children.length) * Math.PI * 2 + t * 4;
        c.position.set(Math.cos(a) * 0.8, 0.2 + t * 1.6 + (i % 3) * 0.2, Math.sin(a) * 0.8);
        c.scale.setScalar(Math.max(0.01, 1 - t / 0.9));
      });
    }
  });
  return (
    <group ref={group}>
      <mesh name="orb">
        <icosahedronGeometry args={[0.22, 1]} />
        <meshStandardMaterial color={fx.color} emissive={fx.color} emissiveIntensity={2.2} />
        <pointLight color={fx.color} intensity={3} distance={4} />
      </mesh>
      <group name="burst" visible={false}>
        {dirs.map((_, i) => (
          <mesh key={i}>
            <octahedronGeometry args={[0.1, 0]} />
            <meshStandardMaterial color={fx.color} emissive={fx.color} emissiveIntensity={2} />
          </mesh>
        ))}
      </group>
      <group name="aura" visible={false}>
        {Array.from({ length: 10 }, (_, i) => (
          <mesh key={i}>
            <octahedronGeometry args={[0.08, 0]} />
            <meshStandardMaterial color={fx.color} emissive={fx.color} emissiveIntensity={2.5} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function PokeBall({ ball }: { ball: BallState }) {
  const ref = useRef<THREE.Group>(null);
  const flash = useRef<THREE.PointLight>(null);
  const stars = useRef<THREE.Group>(null);
  const start = useRef<number | null>(null);
  const tl = ballTimeline(ball.shakes);
  const from = new THREE.Vector3(-2.4, 1.6, 3.4);
  const top = ENEMY_POS.clone().add(new THREE.Vector3(-0.2, 1.4, 0.3));
  const ground = ENEMY_POS.clone().add(new THREE.Vector3(-0.2, 0.2, 0.3));
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
      g.position.y += Math.sin(p * Math.PI) * 1.4;
      g.rotation.x = -p * 12;
    } else if (ms < tl.landAt) {
      const p = (ms - tl.captureAt) / (tl.landAt - tl.captureAt);
      g.position.lerpVectors(top, ground, p * p);
    } else if (ms < tl.resultAt) {
      g.position.copy(ground);
      const local = (ms - tl.landAt) % 600;
      const inShake = ms - tl.landAt < ball.shakes * 600;
      g.rotation.z = inShake && local < 350 ? Math.sin((local / 350) * Math.PI * 2) * 0.45 : 0;
    } else {
      g.position.copy(ground);
      g.visible = ball.caught;
    }
    if (flash.current) flash.current.intensity = ms > tl.captureAt && ms < tl.captureAt + 300 ? 8 : 0;
    if (stars.current) {
      const st = ms - tl.resultAt;
      stars.current.visible = ball.caught && st > 0 && st < 900;
      stars.current.children.forEach((c, i) => {
        const a = (i / 5) * Math.PI * 2;
        c.position.set(Math.cos(a) * st * 0.0012, 0.3 + Math.sin(a) * st * 0.0008 + st * 0.0006, 0);
      });
    }
  });
  return (
    <>
      <group ref={ref} visible={false} scale={0.32}>
        <mesh castShadow>
          <sphereGeometry args={[0.5, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={ball.color} roughness={0.35} />
        </mesh>
        <mesh rotation={[Math.PI, 0, 0]} castShadow>
          <sphereGeometry args={[0.5, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#f5f5f5" roughness={0.35} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.5, 0.04, 6, 24]} />
          <meshStandardMaterial color="#202020" />
        </mesh>
        <mesh position={[0, 0, 0.48]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.13, 0.13, 0.08, 14]} />
          <meshStandardMaterial color="#fafafa" emissive="#ffffff" emissiveIntensity={0.2} />
        </mesh>
        <pointLight ref={flash} color="#ff4040" intensity={0} distance={5} />
      </group>
      <group ref={stars} position={ground.toArray()} visible={false}>
        {Array.from({ length: 5 }, (_, i) => (
          <mesh key={i}>
            <octahedronGeometry args={[0.1, 0]} />
            <meshStandardMaterial color="#ffe14a" emissive="#ffd000" emissiveIntensity={2.5} />
          </mesh>
        ))}
      </group>
    </>
  );
}

function CameraSway() {
  const { camera, size } = useThree();
  const target = useMemo(() => new THREE.Vector3(0.4, 0.15, -0.9), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // Narrow (portrait) screens need the camera further back to keep both creatures in view.
    const k = Math.max(1, Math.min(1.9, 1.25 / (size.width / size.height)));
    const base = new THREE.Vector3(-5.4 + Math.sin(t * 0.25) * 0.35, 3.3 + Math.sin(t * 0.4) * 0.08, 8.4 + Math.cos(t * 0.25) * 0.25);
    camera.position.copy(target).add(base.sub(target).multiplyScalar(k));
    camera.lookAt(target);
  });
  return null;
}

export interface BattleSceneProps {
  biome: Biome;
  seedKey: string;
  player: Combatant | null;
  enemy: Combatant | null;
  fx: FxState | null;
  ball: BallState | null;
  useSprites: boolean;
}

export function BattleScene({ biome, seedKey, player, enemy, fx, ball, useSprites }: BattleSceneProps) {
  const look = BIOME_LOOKS[biome];
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [-5.4, 3.3, 8.4], fov: 40 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <Environment biome={biome} seedKey={seedKey} variant="battle" />
      <CameraSway />
      <Platform position={ENEMY_POS} radius={1.7} color={look.platform} />
      <Platform position={PLAYER_POS} radius={1.9} color={look.platform} />
      {enemy && (
        <group position={ENEMY_POS} rotation={[0, ENEMY_YAW, 0]}>
          <CreatureModel speciesId={enemy.species} shiny={enemy.shiny} anim={enemy.anim} animKey={enemy.animKey} scale={1.3} useSprites={useSprites} />
        </group>
      )}
      {player && (
        <group position={PLAYER_POS} rotation={[0, PLAYER_YAW, 0]}>
          <CreatureModel speciesId={player.species} shiny={player.shiny} anim={player.anim} animKey={player.animKey} scale={1.15} useSprites={useSprites} />
        </group>
      )}
      {fx && <Effect key={fx.key} fx={fx} />}
      {ball && <PokeBall key={ball.key} ball={ball} />}
    </Canvas>
  );
}
