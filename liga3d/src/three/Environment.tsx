import { useMemo, type ReactElement } from 'react';
import * as THREE from 'three';
import type { Biome } from '../data/world';
import { seededRng } from '../engine/rng';
import { BIOME_LOOKS, hashString, terrainHeight } from './biomes';
import {
  Building, Crystal, Dock, Fence, Flower, GrassTuft, Gym, House, Lamp, LavaPool, Log, Mushroom, PineTree, Pokecenter, Pylon,
  Reed, Rock, RoundTree, Shop, Sparks, Volcano, Water, Windmill,
} from './Props';

export interface EnvOptions {
  biome: Biome;
  seedKey: string;
  variant: 'location' | 'battle';
  pokecenter?: boolean;
  shop?: boolean;
  gym?: boolean;
}

function Ground({ biome, seed }: { biome: Biome; seed: number }) {
  const geometry = useMemo(() => {
    const look = BIOME_LOOKS[biome];
    const g = new THREE.PlaneGeometry(70, 70, 56, 56);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c1 = new THREE.Color(look.ground);
    const c2 = new THREE.Color(look.ground2);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = terrainHeight(biome, x, z, seed);
      pos.setY(i, y);
      const mix = 0.5 + 0.5 * Math.sin(x * 0.7 + seed) * Math.cos(z * 0.6 - seed);
      tmp.copy(c1).lerp(c2, mix);
      if (biome === 'mountain' && y > 3) tmp.lerp(new THREE.Color('#f4f6fa'), Math.min(1, (y - 3) / 2));
      if ((biome === 'town' || biome === 'plant') && Math.abs(x) < 1.1 && z < 2) tmp.set(biome === 'town' ? '#d8c69a' : '#8a8e94');
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [biome, seed]);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors flatShading roughness={0.95} />
    </mesh>
  );
}

/** Deterministic biome dressing. Keeps a clear area in the middle for the action. */
function useProps({ biome, seedKey, variant, pokecenter, shop, gym }: EnvOptions): ReactElement[] {
  return useMemo(() => {
    const seed = hashString(seedKey);
    const rng = seededRng(seed);
    const h = (x: number, z: number) => terrainHeight(biome, x, z, seed);
    const out: ReactElement[] = [];
    let k = 0;
    const clearR = variant === 'battle' ? 7.5 : 3.2;
    /** Random point in a ring; in battle mode keep props mostly behind the arena. */
    const spot = (rMin: number, rMax: number): [number, number, number] => {
      for (let tries = 0; tries < 20; tries++) {
        const a = rng() * Math.PI * 2;
        const r = rMin + rng() * (rMax - rMin);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (Math.hypot(x, z) < clearR) continue;
        if (variant === 'battle' && z > 2 && Math.abs(x) < 10) continue;
        if (biome === 'lake' && Math.hypot(x - 1, z + 6) < 6.3) continue;
        return [x, h(x, z), z];
      }
      return [rMax, h(rMax, 0), 0];
    };
    const add = (n: number, rMin: number, rMax: number, make: (p: [number, number, number], i: number) => ReactElement) => {
      for (let i = 0; i < n; i++) out.push(make(spot(rMin, rMax), k++));
    };
    const flowerColors = ['#ff7aa8', '#ffd54f', '#ffffff', '#b388ff', '#ff8a65'];
    const scaleN = variant === 'battle' ? 0.6 : 1;

    switch (biome) {
      case 'town': {
        if (variant === 'location') {
          if (pokecenter) out.push(<Pokecenter key={k++} position={[-5.2, 0, -4.2]} rotation={0.45} />);
          if (shop) out.push(<Shop key={k++} position={[5.2, 0, -4.6]} rotation={-0.45} />);
          if (gym) out.push(<Gym key={k++} position={[0, 0, -9.5]} />);
          out.push(<House key={k++} position={[-9.5, 0, 1]} rotation={1.3} />);
          out.push(<House key={k++} position={[9.5, 0, 1.5]} rotation={-1.3} roof="#5a8ac8" />);
          out.push(<House key={k++} position={[-8, 0, -10]} rotation={0.6} roof="#6aa84f" scale={0.9} />);
          out.push(<Fence key={k++} position={[-3, 0, 4.5]} length={3} />);
          out.push(<Fence key={k++} position={[3, 0, 4.5]} length={3} />);
          for (const p of [[-2, 1.5], [2, 1.5], [-2, -3], [2, -3]] as const) out.push(<Lamp key={k++} position={[p[0], 0, p[1]]} />);
        } else {
          out.push(<House key={k++} position={[-8, 0, -12]} rotation={0.4} />);
          out.push(<Pokecenter key={k++} position={[6, 0, -13]} rotation={-0.3} />);
        }
        add(Math.round(16 * scaleN), 12, 22, (p, i) => <RoundTree key={i} position={p} scale={0.9 + rng() * 0.5} />);
        add(Math.round(30 * scaleN), 4, 12, (p, i) => <Flower key={i} position={p} color={flowerColors[i % 5]} />);
        break;
      }
      case 'meadow':
        add(Math.round(90 * scaleN), 2.5, 18, (p, i) => <GrassTuft key={i} position={p} scale={0.8 + rng() * 0.8} />);
        add(Math.round(45 * scaleN), 3, 16, (p, i) => <Flower key={i} position={p} color={flowerColors[i % 5]} />);
        add(Math.round(10 * scaleN), 10, 22, (p, i) => <RoundTree key={i} position={p} scale={0.9 + rng() * 0.6} />);
        add(5, 6, 16, (p, i) => <Rock key={i} position={p} scale={0.6 + rng() * 0.6} rotation={rng() * 6} />);
        break;
      case 'forest':
        add(Math.round(55 * scaleN), 5, 24, (p, i) => <PineTree key={i} position={p} scale={0.9 + rng() * 0.9} color={rng() > 0.5 ? '#2f7a3f' : '#2a6a38'} />);
        add(Math.round(10 * scaleN), 6, 20, (p, i) => <RoundTree key={i} position={p} scale={1 + rng() * 0.4} color="#3f8f3a" />);
        add(Math.round(18 * scaleN), 3, 12, (p, i) => <Mushroom key={i} position={p} scale={0.8 + rng()} color={rng() > 0.6 ? '#e0a03a' : '#e0402f'} />);
        add(3, 5, 12, (p, i) => <Log key={i} position={[p[0], p[1] + 0.2, p[2]]} rotation={rng() * 3} />);
        add(Math.round(40 * scaleN), 2.5, 14, (p, i) => <GrassTuft key={i} position={p} color="#3f8f2f" />);
        break;
      case 'mountain':
        add(Math.round(40 * scaleN), 4, 22, (p, i) => <Rock key={i} position={p} scale={0.7 + rng() * 1.8} rotation={rng() * 6} color={rng() > 0.5 ? '#8f8578' : '#a39888'} />);
        add(Math.round(10 * scaleN), 12, 24, (p, i) => <PineTree key={i} position={p} scale={0.8 + rng() * 0.5} color="#3a6a48" />);
        add(Math.round(15 * scaleN), 3, 12, (p, i) => <GrassTuft key={i} position={p} color="#8a9a5a" scale={0.7} />);
        break;
      case 'cave':
        add(Math.round(45 * scaleN), 7, 16, (p, i) => <Rock key={i} position={p} scale={1.5 + rng() * 2.5} rotation={rng() * 6} color={rng() > 0.5 ? '#4a4352' : '#5a5262'} />);
        add(Math.round(20 * scaleN), 4, 12, (p, i) => (
          <mesh key={i} position={[p[0], p[1] + 0.6, p[2]]} castShadow>
            <coneGeometry args={[0.3 + rng() * 0.3, 1.2 + rng() * 1.5, 5]} />
            <meshStandardMaterial color="#5a5262" flatShading />
          </mesh>
        ));
        add(variant === 'battle' ? 4 : 8, 4, 10, (p, i) => <Crystal key={i} position={p} scale={0.8 + rng() * 0.8} color={i % 2 ? '#8a6aff' : '#4ac8ff'} />);
        break;
      case 'lake':
        out.push(<Water key={k++} position={[1, -0.12, -6]} radius={6.2} />);
        if (variant === 'location') out.push(<Dock key={k++} position={[1, 0, -1.6]} />);
        for (let i = 0; i < 22; i++) {
          const a = rng() * Math.PI * 2;
          const x = 1 + Math.cos(a) * 6.4;
          const z = -6 + Math.sin(a) * 6.4;
          if (Math.hypot(x, z) < 3 || (variant === 'battle' && z > 2)) continue;
          out.push(<Reed key={k++} position={[x, h(x, z), z]} />);
        }
        add(Math.round(12 * scaleN), 10, 22, (p, i) => <RoundTree key={i} position={p} scale={0.9 + rng() * 0.5} />);
        add(Math.round(40 * scaleN), 3, 15, (p, i) => <GrassTuft key={i} position={p} />);
        add(Math.round(20 * scaleN), 3, 14, (p, i) => <Flower key={i} position={p} color={flowerColors[i % 5]} />);
        break;
      case 'volcano':
        out.push(<Volcano key={k++} position={[3, 0, -24]} />);
        add(variant === 'battle' ? 3 : 6, 5, 14, (p, i) => <LavaPool key={i} position={p} scale={0.7 + rng() * 0.7} />);
        add(Math.round(28 * scaleN), 4, 20, (p, i) => <Rock key={i} position={p} scale={0.6 + rng() * 1.4} rotation={rng() * 6} color="#3f2a26" />);
        add(6, 8, 18, (p, i) => (
          <mesh key={i} position={[p[0], p[1] + 0.9, p[2]]} rotation={[0, 0, (rng() - 0.5) * 0.4]} castShadow>
            <cylinderGeometry args={[0.08, 0.16, 1.8, 5]} />
            <meshStandardMaterial color="#2a1a14" flatShading />
          </mesh>
        ));
        break;
      case 'plant':
        if (variant === 'location') {
          out.push(<Building key={k++} position={[-7, 0, -9]} rotation={0.3} />);
          out.push(<Building key={k++} position={[7.5, 0, -8]} rotation={-0.4} scale={0.85} />);
        } else {
          out.push(<Building key={k++} position={[-6, 0, -14]} rotation={0.2} />);
        }
        add(variant === 'battle' ? 3 : 5, 8, 16, (p, i) => (
          <group key={i}>
            <Pylon position={p} rotation={rng() * 3} />
            <Sparks position={[p[0], p[1] + 4.6, p[2]]} />
          </group>
        ));
        add(Math.round(12 * scaleN), 4, 14, (p, i) => <Rock key={i} position={p} scale={0.5 + rng() * 0.8} color="#6a6e74" />);
        add(4, 3.5, 8, (p, i) => <Lamp key={i} position={p} />);
        break;
      case 'hills':
        out.push(<Windmill key={k++} position={variant === 'battle' ? [-10, h(-10, -14), -14] : [-7.5, h(-7.5, -8), -8]} rotation={0.4} />);
        add(Math.round(9 * scaleN), 9, 22, (p, i) => <RoundTree key={i} position={p} scale={0.9 + rng() * 0.6} color="#5fb04a" />);
        add(Math.round(70 * scaleN), 3, 18, (p, i) => <Flower key={i} position={p} color={flowerColors[i % 5]} />);
        add(Math.round(60 * scaleN), 2.5, 18, (p, i) => <GrassTuft key={i} position={p} color="#6fbf4f" />);
        add(4, 6, 16, (p, i) => <Rock key={i} position={p} scale={0.6 + rng() * 0.5} />);
        break;
    }
    return out;
  }, [biome, seedKey, variant, pokecenter, shop, gym]);
}

export function Environment(props: EnvOptions) {
  const look = BIOME_LOOKS[props.biome];
  const seed = hashString(props.seedKey);
  const items = useProps(props);
  return (
    <>
      <color attach="background" args={[look.sky]} />
      <fog attach="fog" args={[look.fog, look.fogNear, look.fogFar]} />
      <hemisphereLight args={[look.hemiSky, look.hemiGround, look.ambient + 0.4]} />
      <ambientLight intensity={look.ambient * 0.5} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={look.sunIntensity}
        color={look.sun}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-bias={-0.0005}
      />
      <Ground biome={props.biome} seed={seed} />
      {items}
    </>
  );
}
