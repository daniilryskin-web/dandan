import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { LocationData } from '../data/world';
import { seededRng } from '../engine/rng';
import { hashString, terrainHeight } from './biomes';
import { CreatureModel } from './CreatureModel';
import { Environment } from './Environment';
import { Trainer } from './Trainer';

interface Wild {
  species: number;
  seen: boolean;
}

function Wanderer({ wild, seed, biome, terrainSeed, useSprites }: { wild: Wild; seed: number; biome: LocationData['biome']; terrainSeed: number; useSprites: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const rng = useMemo(() => seededRng(seed), [seed]);
  const state = useRef({ x: 0, z: 0, tx: 0, tz: 0, wait: 0, init: false });
  const pick = () => {
    const a = rng() * Math.PI * 2;
    const r = 4 + rng() * 5;
    let x = Math.cos(a) * r;
    let z = Math.sin(a) * r;
    if (biome === 'lake' && Math.hypot(x - 1, z + 6) < 6.5) {
      x = -x;
      z = Math.abs(z);
    }
    return [x, z];
  };
  useFrame((_, dt) => {
    const s = state.current;
    const g = ref.current;
    if (!g) return;
    if (!s.init) {
      [s.x, s.z] = pick();
      [s.tx, s.tz] = pick();
      s.init = true;
    }
    if (s.wait > 0) {
      s.wait -= dt;
    } else {
      const dx = s.tx - s.x;
      const dz = s.tz - s.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.1) {
        s.wait = 1 + rng() * 3;
        [s.tx, s.tz] = pick();
      } else {
        const step = Math.min(d, dt * 0.9);
        s.x += (dx / d) * step;
        s.z += (dz / d) * step;
        const target = Math.atan2(dx, dz);
        g.rotation.y += Math.atan2(Math.sin(target - g.rotation.y), Math.cos(target - g.rotation.y)) * Math.min(1, dt * 5);
      }
    }
    g.position.set(s.x, terrainHeight(biome, s.x, s.z, terrainSeed), s.z);
  });
  return (
    <group ref={ref}>
      <CreatureModel speciesId={wild.species} silhouette={!wild.seen} scale={0.75} bobSeed={seed % 10} useSprites={useSprites} />
    </group>
  );
}

function CameraRig() {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / size.height;
    if (aspect < 1) camera.position.multiplyScalar(Math.min(1.6, 1.15 / aspect));
    // Only on mount: OrbitControls owns the camera afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <OrbitControls
      makeDefault
      target={[0, 0.8, 0]}
      enablePan={false}
      minDistance={6}
      maxDistance={20}
      minPolarAngle={0.4}
      maxPolarAngle={1.32}
      autoRotate
      autoRotateSpeed={0.35}
      enableDamping
    />
  );
}

export interface LocationSceneProps {
  location: LocationData;
  wild: Wild[];
  lead?: { species: number; shiny: boolean } | null;
  useSprites: boolean;
}

export function LocationScene({ location, wild, lead, useSprites }: LocationSceneProps) {
  const terrainSeed = hashString(location.id);
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [0, 6.5, 12.5], fov: 45 }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <Environment biome={location.biome} seedKey={location.id} variant="location" pokecenter={location.pokecenter} shop={!!location.shop} gym={!!location.gym} />
      <Trainer position={[0, terrainHeight(location.biome, 0, 1, terrainSeed), 1]} rotation={0.2} />
      {lead && (
        <group position={[1.3, terrainHeight(location.biome, 1.3, 1.6, terrainSeed), 1.6]} rotation={[0, -0.3, 0]}>
          <CreatureModel speciesId={lead.species} shiny={lead.shiny} scale={0.8} useSprites={useSprites} />
        </group>
      )}
      {wild.slice(0, 5).map((w, i) => (
        <Wanderer key={`${location.id}-${w.species}-${i}`} wild={w} seed={terrainSeed + i * 7919} biome={location.biome} terrainSeed={terrainSeed} useSprites={useSprites} />
      ))}
      <CameraRig />
    </Canvas>
  );
}
