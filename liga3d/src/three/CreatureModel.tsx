import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { getSpecies, type Look } from '../data/species';
import { useSprite, type SpriteImage } from './sprites';

export type CreatureAnim = 'idle' | 'attack' | 'hit' | 'faint' | 'hidden' | 'appear' | 'capture';

interface Palette {
  body: string;
  accent: string;
  belly: string;
}

function shift(hex: string, dh: number, ds = 0, dl = 0): string {
  const c = new THREE.Color(hex);
  c.offsetHSL(dh, ds, dl);
  return '#' + c.getHexString();
}

export function paletteFor(look: Look, shiny: boolean): Palette {
  const belly = look.belly ?? shift(look.color, 0, -0.1, 0.18);
  if (!shiny) return { body: look.color, accent: look.accent, belly };
  return { body: shift(look.color, 0.42, 0.05, 0.02), accent: shift(look.accent, 0.3, 0.05), belly: shift(belly, 0.42) };
}

type Vec = [number, number, number];

interface PartProps {
  geo: 'sphere' | 'cone' | 'cyl' | 'box' | 'torus' | 'oct';
  args?: number[];
  color: string;
  position?: Vec;
  rotation?: Vec;
  scale?: Vec | number;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  smooth?: boolean;
  children?: ReactNode;
}

function Part({ geo, args = [], color, position, rotation, scale, emissive, emissiveIntensity = 0.6, opacity = 1, smooth, children }: PartProps) {
  return (
    <mesh position={position} rotation={rotation} scale={scale} castShadow receiveShadow={false}>
      {geo === 'sphere' && <icosahedronGeometry args={[args[0] ?? 0.5, args[1] ?? 1]} />}
      {geo === 'cone' && <coneGeometry args={[args[0] ?? 0.2, args[1] ?? 0.5, args[2] ?? 6]} />}
      {geo === 'cyl' && <cylinderGeometry args={[args[0] ?? 0.1, args[1] ?? 0.1, args[2] ?? 0.4, args[3] ?? 7]} />}
      {geo === 'box' && <boxGeometry args={[args[0] ?? 0.2, args[1] ?? 0.2, args[2] ?? 0.2]} />}
      {geo === 'torus' && <torusGeometry args={[args[0] ?? 0.3, args[1] ?? 0.06, args[2] ?? 6, args[3] ?? 14, args[4] ?? Math.PI * 2]} />}
      {geo === 'oct' && <octahedronGeometry args={[args[0] ?? 0.3, 0]} />}
      <meshStandardMaterial
        color={color}
        flatShading={!smooth}
        roughness={0.65}
        metalness={0.05}
        emissive={emissive ?? '#000000'}
        emissiveIntensity={emissive ? emissiveIntensity : 0}
        transparent={opacity < 1}
        opacity={opacity}
      />
      {children}
    </mesh>
  );
}

function Eyes({ y, z, spread = 0.13, size = 0.075, color = '#1d1d24' }: { y: number; z: number; spread?: number; size?: number; color?: string }) {
  return (
    <group>
      {[-1, 1].map((s) => (
        <group key={s} position={[s * spread, y, z]}>
          <Part geo="sphere" args={[size, 1]} color="#fafafa" smooth />
          <Part geo="sphere" args={[size * 0.62, 1]} color={color} position={[0, 0, size * 0.55]} smooth />
          <Part geo="sphere" args={[size * 0.22, 0]} color="#ffffff" position={[size * 0.2, size * 0.25, size * 0.95]} emissive="#ffffff" />
        </group>
      ))}
    </group>
  );
}

function Ears({ kind, y, z, spread, color, tip }: { kind: Look['ears']; y: number; z: number; spread: number; color: string; tip: string }) {
  if (!kind) return null;
  return (
    <group>
      {[-1, 1].map((s) => {
        const pos: Vec = [s * spread, y, z];
        if (kind === 'round') return <Part key={s} geo="sphere" args={[0.12, 1]} color={color} position={pos} scale={[1, 1, 0.45]} />;
        if (kind === 'fin')
          return <Part key={s} geo="cone" args={[0.12, 0.32, 3]} color={tip} position={pos} rotation={[0, 0, -s * 1.1]} scale={[1, 1, 0.3]} />;
        const long = kind === 'long';
        return (
          <group key={s} position={pos} rotation={[0, 0, -s * (long ? 0.35 : 0.3)]}>
            <Part geo="cone" args={[long ? 0.09 : 0.1, long ? 0.48 : 0.26, 5]} color={color} position={[0, long ? 0.2 : 0.1, 0]} />
            {long && <Part geo="cone" args={[0.05, 0.16, 5]} color={tip} position={[0, 0.39, 0]} />}
          </group>
        );
      })}
    </group>
  );
}

function Horns({ count, y, z, color }: { count: number; y: number; z: number; color: string }) {
  if (!count) return null;
  const items = Array.from({ length: count }, (_, i) => (count === 1 ? 0 : -0.5 + i / (count - 1)));
  return (
    <group>
      {items.map((t, i) => (
        <Part key={i} geo="cone" args={[0.05, 0.22, 5]} color={color} position={[t * 0.22, y, z]} rotation={[-0.3, 0, -t * 0.7]} />
      ))}
    </group>
  );
}

function Tail({ kind, pos, color, accent, flameRef }: { kind: Look['tail']; pos: Vec; color: string; accent: string; flameRef: React.RefObject<THREE.Mesh> }) {
  if (!kind) return null;
  switch (kind) {
    case 'flame':
      return (
        <group position={pos} rotation={[-0.9, 0, 0]}>
          <Part geo="cyl" args={[0.04, 0.08, 0.45]} color={color} position={[0, 0.2, 0]} />
          <mesh ref={flameRef} position={[0, 0.48, 0]}>
            <icosahedronGeometry args={[0.13, 1]} />
            <meshStandardMaterial color="#ffb347" emissive="#ff6a00" emissiveIntensity={1.8} flatShading transparent opacity={0.9} />
          </mesh>
          <pointLight position={[0, 0.5, 0]} color="#ff8a2a" intensity={1.2} distance={2} />
        </group>
      );
    case 'leaf':
      return <Part geo="sphere" args={[0.18, 1]} color={accent} position={pos} scale={[0.5, 1.4, 0.25]} rotation={[-0.6, 0, 0]} />;
    case 'bolt':
      return (
        <group position={pos} rotation={[-0.3, 0, 0]}>
          <Part geo="box" args={[0.08, 0.28, 0.06]} color={color} position={[0, 0.12, -0.05]} rotation={[0, 0, 0.6]} />
          <Part geo="box" args={[0.24, 0.3, 0.06]} color={color} position={[0.05, 0.36, -0.08]} rotation={[0, 0, -0.5]} />
          <Part geo="box" args={[0.3, 0.32, 0.06]} color={color} position={[-0.02, 0.6, -0.1]} rotation={[0, 0, 0.4]} />
        </group>
      );
    case 'thin':
      return <Part geo="cyl" args={[0.025, 0.05, 0.6]} color={color} position={pos} rotation={[-1.1, 0, 0]} />;
    case 'fluffy':
      return <Part geo="sphere" args={[0.24, 1]} color={accent} position={pos} scale={[0.85, 1.25, 1]} rotation={[-0.7, 0, 0]} />;
    case 'fin':
      return <Part geo="cone" args={[0.22, 0.35, 3]} color={accent} position={pos} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.25]} />;
    case 'stinger':
      return <Part geo="cone" args={[0.07, 0.3, 5]} color={accent} position={pos} rotation={[-Math.PI / 2, 0, 0]} />;
    case 'curl':
      return <Part geo="torus" args={[0.13, 0.05, 5, 10, Math.PI * 1.5]} color={color} position={pos} rotation={[0, Math.PI / 2, 0]} />;
    case 'club':
      return <Part geo="sphere" args={[0.15, 1]} color={accent} position={pos} />;
  }
}

function Bulb({ kind, pos, palette }: { kind: Look['bulb']; pos: Vec; palette: Palette }) {
  if (!kind) return null;
  if (kind === 'bud')
    return (
      <group position={pos}>
        <Part geo="sphere" args={[0.33, 1]} color={palette.accent} scale={[1, 1.2, 1]} />
        {[0, 1, 2, 3].map((i) => (
          <Part key={i} geo="sphere" args={[0.12, 1]} color={shift(palette.accent, 0, 0, 0.1)} position={[Math.cos(i * 1.57) * 0.22, -0.12, Math.sin(i * 1.57) * 0.22]} scale={[1, 0.4, 1]} />
        ))}
      </group>
    );
  if (kind === 'flower')
    return (
      <group position={pos}>
        <Part geo="cyl" args={[0.08, 0.12, 0.2]} color="#7a5230" />
        {Array.from({ length: 5 }, (_, i) => {
          const a = (i / 5) * Math.PI * 2;
          return (
            <Part key={i} geo="sphere" args={[0.2, 1]} color="#ef6f8f" position={[Math.cos(a) * 0.26, 0.12, Math.sin(a) * 0.26]} scale={[1, 0.3, 0.7]} rotation={[0, -a, 0]} />
          );
        })}
        <Part geo="sphere" args={[0.1, 1]} color="#ffe066" position={[0, 0.16, 0]} emissive="#ffcc33" emissiveIntensity={0.2} />
        {[0, 2, 4].map((i) => (
          <Part key={i} geo="sphere" args={[0.18, 1]} color={palette.accent} position={[Math.cos(i) * 0.3, -0.02, Math.sin(i) * 0.3]} scale={[1.2, 0.25, 0.6]} />
        ))}
      </group>
    );
  if (kind === 'leaves')
    return (
      <group position={pos}>
        {[-0.5, 0, 0.5, 1.6, 2.6].map((a, i) => (
          <Part key={i} geo="sphere" args={[0.15, 1]} color={palette.accent} position={[Math.sin(a) * 0.12, 0.22, Math.cos(a) * 0.08]} scale={[0.6, 1.7, 0.25]} rotation={[Math.cos(a) * 0.4, a, Math.sin(a) * 0.5]} />
        ))}
      </group>
    );
  return (
    <group position={pos}>
      <mesh castShadow>
        <sphereGeometry args={[0.36, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={palette.accent} flatShading />
      </mesh>
      {[0, 1.3, 2.6, 3.9, 5.2].map((a, i) => (
        <Part key={i} geo="sphere" args={[0.05, 0]} color="#fff3c4" position={[Math.cos(a) * 0.22, 0.25, Math.sin(a) * 0.22]} />
      ))}
    </group>
  );
}

function Spikes({ y, z0, z1, color }: { y: number; z0: number; z1: number; color: string }) {
  return (
    <group>
      {[0, 1, 2, 3].map((i) => {
        const z = z0 + ((z1 - z0) * i) / 3;
        return <Part key={i} geo="cone" args={[0.07, 0.22, 4]} color={color} position={[0, y - Math.abs(i - 1.5) * 0.04, z]} rotation={[-0.4, 0, 0]} />;
      })}
    </group>
  );
}

function Wings({ kind, y, z, span, palette, wingRef }: { kind: Look['wings']; y: number; z: number; span: number; palette: Palette; wingRef: React.RefObject<THREE.Group> }) {
  if (!kind) return null;
  return (
    <group ref={wingRef} position={[0, y, z]}>
      {[-1, 1].map((s) => (
        <group key={s} name={s < 0 ? 'wingL' : 'wingR'} position={[s * span * 0.35, 0, 0]}>
          {kind === 'feather' && (
            <Part geo="sphere" args={[0.3, 1]} color={palette.body} position={[s * 0.3, 0.05, -0.05]} scale={[1.5, 0.35, 0.9]} rotation={[0, 0, s * 0.35]} />
          )}
          {kind === 'insect' &&
            [0, 1].map((k) => (
              <Part key={k} geo="sphere" args={[0.32, 1]} color={palette.accent} opacity={0.75} position={[s * 0.35, 0.2 - k * 0.32, -0.08]} scale={[1.2, k ? 0.7 : 1, 0.08]} rotation={[0, 0, s * (k ? -0.4 : 0.5)]} />
            ))}
          {kind === 'bat' && (
            <Part geo="cone" args={[0.45, 0.8, 3]} color={palette.accent} position={[s * 0.38, 0.05, -0.05]} rotation={[0, 0, s * 1.6]} scale={[1, 1, 0.15]} />
          )}
        </group>
      ))}
    </group>
  );
}

/** Builds the static body for a look, centred at the origin, facing +Z, about one unit tall. */
function Body({ look, palette, flameRef, wingRef, gasRef }: {
  look: Look; palette: Palette; flameRef: React.RefObject<THREE.Mesh>; wingRef: React.RefObject<THREE.Group>; gasRef: React.RefObject<THREE.Mesh>;
}) {
  const { body, accent, belly } = palette;
  switch (look.shape) {
    case 'quad': {
      const headY = 0.92;
      const headZ = 0.55;
      return (
        <group>
          <Part geo="sphere" args={[0.5, 1]} color={body} position={[0, 0.58, 0]} scale={[1.05, 0.85, 1.4]} />
          <Part geo="sphere" args={[0.42, 1]} color={belly} position={[0, 0.48, 0.08]} scale={[0.95, 0.7, 1.2]} />
          {[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([x, zz], i) => (
            <Part key={i} geo="cyl" args={[0.1, 0.08, 0.42]} color={body} position={[x * 0.3, 0.2, zz * 0.42]} />
          ))}
          <group position={[0, headY, headZ]}>
            <Part geo="sphere" args={[0.38, 1]} color={body} />
            <Part geo="sphere" args={[0.17, 1]} color={belly} position={[0, -0.1, 0.3]} scale={[1.2, 0.85, 1]} />
            <Part geo="sphere" args={[0.04, 0]} color="#1d1d24" position={[0, -0.04, 0.47]} />
            <Eyes y={0.06} z={0.28} spread={0.16} size={0.08} />
            <Ears kind={look.ears} y={0.3} z={-0.02} spread={0.22} color={body} tip={accent} />
            <Horns count={look.horns ?? 0} y={0.36} z={0.08} color={accent} />
          </group>
          {look.mane && (
            <group position={[0, headY - 0.15, headZ - 0.2]}>
              {Array.from({ length: 7 }, (_, i) => {
                const a = (i / 7) * Math.PI * 2;
                return <Part key={i} geo="sphere" args={[0.13, 1]} color={accent} position={[Math.cos(a) * 0.3, Math.sin(a) * 0.22, -0.05]} />;
              })}
            </group>
          )}
          {look.shell && <Part geo="sphere" args={[0.55, 1]} color={accent} position={[0, 0.8, -0.05]} scale={[1, 0.55, 1.3]} />}
          {look.spikes && <Spikes y={1.02} z0={0.2} z1={-0.55} color={accent} />}
          <Bulb kind={look.bulb} pos={[0, 1.12, -0.18]} palette={palette} />
          <Tail kind={look.tail} pos={[0, 0.7, -0.72]} color={body} accent={accent} flameRef={flameRef} />
        </group>
      );
    }
    case 'biped': {
      const headY = 1.28;
      return (
        <group>
          <Part geo="sphere" args={[0.48, 1]} color={body} position={[0, 0.62, 0]} scale={[1, 1.15, 0.92]} />
          <Part geo="sphere" args={[0.38, 1]} color={belly} position={[0, 0.58, 0.16]} scale={[0.95, 1.1, 0.7]} />
          {[-1, 1].map((s) => (
            <Part key={s} geo="sphere" args={[0.15, 1]} color={body} position={[s * 0.24, 0.12, 0.08]} scale={[1, 0.8, 1.4]} />
          ))}
          {[-1, 1].map((s) => (
            <Part key={s} geo="cyl" args={[look.arms ? 0.1 : 0.07, look.arms ? 0.13 : 0.06, look.arms ? 0.5 : 0.36]} color={body} position={[s * 0.46, 0.78, 0.1]} rotation={[0.4, 0, s * 0.8]} />
          ))}
          <group position={[0, headY, 0.05]}>
            <Part geo="sphere" args={[0.38, 1]} color={body} />
            {look.beak ? (
              <Part geo="sphere" args={[0.16, 1]} color={accent} position={[0, -0.08, 0.34]} scale={[1.3, 0.55, 1.1]} />
            ) : (
              <Part geo="sphere" args={[0.13, 1]} color={belly} position={[0, -0.12, 0.3]} scale={[1.3, 0.8, 0.8]} />
            )}
            <Eyes y={0.06} z={0.28} spread={0.15} size={0.085} />
            <Ears kind={look.ears} y={0.28} z={0} spread={0.22} color={body} tip={look.ears === 'long' ? '#2a2a2a' : accent} />
            <Horns count={look.horns ?? 0} y={0.36} z={0.05} color={accent} />
          </group>
          {look.mane && <Part geo="torus" args={[0.3, 0.1, 5, 12]} color={accent} position={[0, headY - 0.32, 0]} rotation={[Math.PI / 2, 0, 0]} />}
          {look.shell && <Part geo="sphere" args={[0.5, 1]} color={accent} position={[0, 0.66, -0.2]} scale={[1.05, 1.2, 0.7]} />}
          {look.spikes && <Spikes y={1.0} z0={-0.15} z1={-0.42} color={accent} />}
          <Bulb kind={look.bulb} pos={[0, headY + 0.3, 0]} palette={palette} />
          <Wings kind={look.wings} y={0.95} z={-0.3} span={1} palette={palette} wingRef={wingRef} />
          <Tail kind={look.tail} pos={[0, 0.45, -0.5]} color={body} accent={accent} flameRef={flameRef} />
        </group>
      );
    }
    case 'bird': {
      const y = look.floating ? 1.05 : 0.8;
      return (
        <group>
          <Part geo="sphere" args={[0.42, 1]} color={body} position={[0, y, 0]} scale={[1, 1, 1.1]} />
          <Part geo="sphere" args={[0.32, 1]} color={belly} position={[0, y - 0.08, 0.16]} scale={[1, 1, 0.8]} />
          <group position={[0, y + 0.42, 0.18]}>
            <Part geo="sphere" args={[0.27, 1]} color={body} />
            {look.beak && <Part geo="cone" args={[0.08, 0.24, 5]} color="#f2a33a" position={[0, -0.04, 0.3]} rotation={[Math.PI / 2, 0, 0]} />}
            <Eyes y={0.05} z={0.2} spread={0.12} size={0.07} color={look.wings === 'insect' ? '#c0303a' : '#1d1d24'} />
            <Ears kind={look.ears} y={0.2} z={-0.02} spread={0.14} color={body} tip={accent} />
            <Horns count={look.horns ?? 0} y={0.26} z={-0.05} color={accent} />
          </group>
          {look.mane && <Part geo="cone" args={[0.12, 0.4, 4]} color={accent} position={[0, y + 0.65, 0.05]} rotation={[-0.9, 0, 0]} />}
          {!look.floating &&
            [-1, 1].map((s) => <Part key={s} geo="cyl" args={[0.03, 0.03, 0.4]} color="#e0a050" position={[s * 0.14, 0.25, 0.05]} />)}
          <Wings kind={look.wings} y={y + 0.05} z={-0.05} span={1} palette={palette} wingRef={wingRef} />
          {look.wings === 'feather' && <Part geo="cone" args={[0.18, 0.4, 4]} color={body} position={[0, y - 0.1, -0.45]} rotation={[-2.2, 0, 0]} />}
          <Tail kind={look.tail} pos={[0, y - 0.25, -0.35]} color={body} accent={accent} flameRef={flameRef} />
        </group>
      );
    }
    case 'fish':
      return (
        <group position={[0, 0.65, 0]}>
          <Part geo="sphere" args={[0.42, 1]} color={body} scale={[0.75, 1.05, 1.3]} />
          <Part geo="sphere" args={[0.32, 1]} color={belly} position={[0, -0.12, 0.12]} scale={[0.7, 0.8, 1.2]} />
          <Eyes y={0.12} z={0.36} spread={0.2} size={0.1} />
          <Part geo="torus" args={[0.09, 0.03, 5, 10]} color={accent} position={[0, -0.12, 0.52]} />
          {[-1, 1].map((s) => (
            <Part key={s} geo="cyl" args={[0.015, 0.02, 0.5]} color={accent} position={[s * 0.18, -0.05, 0.55]} rotation={[0.5, 0, s * 1.2]} />
          ))}
          <Part geo="cone" args={[0.3, 0.5, 3]} color={accent} position={[0, 0.45, -0.1]} scale={[0.2, 1, 1]} />
          {[-1, 1].map((s) => (
            <Part key={s} geo="cone" args={[0.16, 0.3, 3]} color={accent} position={[s * 0.32, -0.15, 0.05]} rotation={[0, 0, s * 2]} scale={[1, 1, 0.2]} />
          ))}
          <Part geo="cone" args={[0.38, 0.45, 3]} color={accent} position={[0, 0, -0.7]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.2, 1, 1]} />
        </group>
      );
    case 'serpent': {
      const n = look.segments ?? 6;
      const segs = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        return {
          pos: [Math.sin(t * Math.PI * 1.6) * 0.35, 0.22 + t * t * 1.15, -0.9 + t * 1.15] as Vec,
          r: 0.17 + t * 0.14,
        };
      });
      const head = segs[n - 1];
      const rocky = getSpeciesLookRocky(look);
      return (
        <group>
          {segs.slice(0, -1).map((s, i) => (
            <group key={i}>
              {rocky ? <Part geo="oct" args={[s.r * 1.2]} color={i % 2 ? body : accent} position={s.pos} /> : <Part geo="sphere" args={[s.r, 1]} color={body} position={s.pos} />}
              {!rocky && look.belly && <Part geo="sphere" args={[s.r * 0.8, 1]} color={belly} position={[s.pos[0], s.pos[1] - 0.04, s.pos[2] + s.r * 0.35]} />}
            </group>
          ))}
          <group position={head.pos}>
            {rocky ? <Part geo="oct" args={[0.42]} color={body} scale={[1, 0.8, 1.2]} /> : <Part geo="sphere" args={[0.34, 1]} color={body} scale={[1, 0.9, 1.15]} />}
            <Eyes y={0.1} z={0.28} spread={0.17} size={0.08} />
            <Ears kind={look.ears} y={0.12} z={-0.02} spread={0.3} color={body} tip={accent} />
            <Horns count={look.horns ?? 0} y={0.3} z={0} color={accent} />
            {look.mane && <Part geo="cone" args={[0.32, 0.18, 7]} color={accent} position={[0, 0.05, -0.2]} rotation={[-1.2, 0, 0]} scale={[1.4, 1, 1]} />}
          </group>
          <Tail kind={look.tail} pos={[segs[0].pos[0], segs[0].pos[1], segs[0].pos[2] - 0.15]} color={body} accent={accent} flameRef={flameRef} />
        </group>
      );
    }
    case 'larva': {
      const n = look.segments ?? 4;
      return (
        <group>
          {Array.from({ length: n }, (_, i) => {
            const z = -0.55 + (i / Math.max(1, n - 1)) * 0.75;
            const r = 0.24 + (i / n) * 0.06;
            return (
              <group key={i}>
                <Part geo="sphere" args={[r, 1]} color={i % 2 ? body : shift(body, 0, 0, -0.05)} position={[0, r, z]} />
                <Part geo="sphere" args={[r * 0.7, 1]} color={belly} position={[0, r * 0.7, z + 0.05]} scale={[1, 0.6, 1]} />
              </group>
            );
          })}
          <group position={[0, 0.42, 0.42]}>
            <Part geo="sphere" args={[0.33, 1]} color={body} />
            <Eyes y={0.06} z={0.25} spread={0.15} size={0.085} />
            <Horns count={look.horns ?? 0} y={0.32} z={0} color={accent} />
          </group>
          <Bulb kind={look.bulb} pos={[0, 0.6, -0.1]} palette={palette} />
          <Tail kind={look.tail} pos={[0, 0.25, -0.8]} color={body} accent={accent} flameRef={flameRef} />
        </group>
      );
    }
    case 'blob': {
      const y = look.floating ? 0.85 : 0.5;
      const copies = look.segments && look.segments > 1 ? look.segments : 1;
      const offsets: Vec[] = copies === 1 ? [[0, 0, 0]] : [[-0.4, 0, 0], [0.4, 0, 0], [0, 0.55, 0]].slice(0, copies) as Vec[];
      return (
        <group>
          {offsets.map((o, idx) => (
            <group key={idx} position={[o[0], y + o[1], o[2]]} scale={copies > 1 ? 0.7 : 1}>
              {look.magnet ? (
                <>
                  <Part geo="sphere" args={[0.38, 1]} color={body} smooth />
                  <Eyes y={0} z={0.3} spread={0.001} size={0.14} />
                  {[-1, 1].map((s) => (
                    <group key={s} position={[s * 0.5, 0, 0]} rotation={[0, 0, s * Math.PI / 2]}>
                      <Part geo="torus" args={[0.16, 0.06, 6, 12, Math.PI]} color="#9aa4b0" />
                      <Part geo="box" args={[0.12, 0.08, 0.12]} color={s < 0 ? '#e04040' : '#3a6fe0'} position={[-0.16, -0.04, 0]} />
                      <Part geo="box" args={[0.12, 0.08, 0.12]} color={s < 0 ? '#3a6fe0' : '#e04040'} position={[0.16, -0.04, 0]} />
                    </group>
                  ))}
                  <Part geo="cyl" args={[0.05, 0.08, 0.2]} color="#c0c8d0" position={[0, 0.45, 0]} />
                </>
              ) : (
                <>
                  <Part geo="sphere" args={[0.46, 1]} color={body} scale={look.spikes ? [0.85, 1.2, 0.85] : 1} />
                  {look.shape === 'blob' && !look.gas && <Part geo="sphere" args={[0.3, 1]} color={belly} position={[0, -0.12, 0.24]} scale={[1, 0.8, 0.6]} />}
                  <Eyes y={0.08} z={0.36} spread={0.15} size={0.09} color={look.gas ? '#f5f5f5' : '#1d1d24'} />
                  <Ears kind={look.ears} y={0.4} z={0} spread={0.2} color={body} tip={accent} />
                  <Horns count={look.horns ?? 0} y={0.42} z={0.05} color={accent} />
                  {look.spikes && <Spikes y={0.45} z0={0.1} z1={-0.3} color={accent} />}
                  {look.arms &&
                    [-1, 1].map((s) => (
                      <group key={s} position={[s * 0.52, -0.05, 0.1]}>
                        <Part geo="cyl" args={[0.08, 0.1, 0.3]} color={body} rotation={[0, 0, s * 1.2]} />
                        <Part geo="sphere" args={[0.14, 1]} color={look.gas ? accent : body} position={[s * 0.18, -0.06, 0.05]} />
                      </group>
                    ))}
                  <Bulb kind={look.bulb} pos={[0, 0.42, 0]} palette={palette} />
                </>
              )}
            </group>
          ))}
          {look.gas && (
            <mesh ref={gasRef} position={[0, y, 0]}>
              <icosahedronGeometry args={[0.72, 2]} />
              <meshStandardMaterial color={accent} transparent opacity={0.28} emissive={accent} emissiveIntensity={0.4} depthWrite={false} />
            </mesh>
          )}
          {!look.floating && !look.magnet && look.ears === undefined && look.horns === undefined && !look.arms && !look.bulb && look.spikes === undefined && (
            <Part geo="cyl" args={[0.5, 0.55, 0.12, 10]} color="#7a5a3a" position={[0, 0.05, 0]} />
          )}
          <Tail kind={look.tail} pos={[0, y - 0.1, -0.45]} color={body} accent={accent} flameRef={flameRef} />
        </group>
      );
    }
  }
}

function getSpeciesLookRocky(look: Look): boolean {
  return look.color === '#8a8a8a';
}

export interface CreatureModelProps {
  speciesId: number;
  shiny?: boolean;
  anim?: CreatureAnim;
  /** Changes whenever a new one-shot animation should start. */
  animKey?: number;
  /** World direction (+1 / -1 along local Z) the attack lunge goes. */
  lunge?: number;
  silhouette?: boolean;
  scale?: number;
  bobSeed?: number;
  /** Use an imported image instead of the procedural model when one exists. */
  useSprites?: boolean;
}

/** Procedural low-poly creature with idle and battle animations. */
export function CreatureModel({ speciesId, shiny = false, anim = 'idle', animKey = 0, lunge = 1, silhouette = false, scale = 1, bobSeed = 0, useSprites = false }: CreatureModelProps) {
  const sp = getSpecies(speciesId);
  const sprite = useSprite(speciesId, shiny, useSprites);
  const look = sp.look;
  const palette = useMemo(() => {
    if (silhouette) return { body: '#1c1f2b', accent: '#1c1f2b', belly: '#1c1f2b' };
    return paletteFor(look, shiny);
  }, [look, shiny, silhouette]);
  const root = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const flameRef = useRef<THREE.Mesh>(null);
  const wingRef = useRef<THREE.Group>(null);
  const gasRef = useRef<THREE.Mesh>(null);
  const start = useRef({ key: -1, t: 0 });
  const size = look.size * scale;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + bobSeed;
    if (start.current.key !== animKey) start.current = { key: animKey, t: clock.elapsedTime };
    const dt = clock.elapsedTime - start.current.t;
    const g = inner.current;
    const r = root.current;
    if (!g || !r) return;
    const floating = look.floating || look.shape === 'bird' || look.wings !== undefined;
    let y = Math.sin(t * 2.2) * (floating ? 0.06 : 0.02);
    let z = 0;
    let x = 0;
    let s = 1 + Math.sin(t * 2.2) * 0.015;
    let visible = true;
    let rotZ = 0;
    switch (anim) {
      case 'attack': {
        const p = Math.min(1, dt / 0.45);
        z = Math.sin(p * Math.PI) * 0.9 * lunge;
        y += Math.sin(p * Math.PI) * 0.25;
        break;
      }
      case 'hit': {
        const p = Math.min(1, dt / 0.5);
        x = Math.sin(dt * 60) * 0.08 * (1 - p);
        visible = p >= 1 || Math.floor(dt * 14) % 2 === 0;
        break;
      }
      case 'faint': {
        const p = Math.min(1, dt / 0.7);
        y -= p * 1.2;
        s *= 1 - p * 0.3;
        rotZ = p * 0.4;
        visible = p < 1;
        break;
      }
      case 'hidden':
        visible = false;
        break;
      case 'appear': {
        const p = Math.min(1, dt / 0.45);
        s *= 0.2 + 0.8 * (1 - (1 - p) ** 3);
        break;
      }
      case 'capture': {
        const p = Math.min(1, dt / 0.4);
        s *= 1 - p;
        visible = p < 1;
        break;
      }
    }
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    g.rotation.z = rotZ;
    r.visible = visible;
    if (flameRef.current) {
      const f = 1 + Math.sin(t * 18) * 0.12 + Math.sin(t * 7) * 0.08;
      flameRef.current.scale.set(f, f * 1.2, f);
    }
    if (wingRef.current) {
      const flap = Math.sin(t * (look.wings === 'insect' ? 16 : 6)) * 0.35;
      const l = wingRef.current.getObjectByName('wingL');
      const rr = wingRef.current.getObjectByName('wingR');
      if (l) l.rotation.z = flap;
      if (rr) rr.rotation.z = -flap;
    }
    if (gasRef.current) gasRef.current.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
  });

  return (
    <group ref={root} scale={size}>
      <group ref={inner}>
        {sprite ? (
          <SpriteBody sprite={sprite} silhouette={silhouette} />
        ) : (
          <Body look={look} palette={palette} flameRef={flameRef} wingRef={wingRef} gasRef={gasRef} />
        )}
      </group>
      {shiny && !silhouette && <ShinySparkles />}
    </group>
  );
}

/** Camera-facing image standing on the ground, about 1.3 units tall. */
function SpriteBody({ sprite, silhouette }: { sprite: SpriteImage; silhouette: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const h = 1.35;
  const w = h * sprite.aspect;
  useFrame(({ camera }) => {
    if (!ref.current || !ref.current.parent) return;
    // Billboard around the vertical axis only, so the image keeps standing on the ground.
    const world = new THREE.Vector3();
    ref.current.parent.getWorldPosition(world);
    const parentQuat = new THREE.Quaternion();
    ref.current.parent.getWorldQuaternion(parentQuat);
    const yaw = Math.atan2(camera.position.x - world.x, camera.position.z - world.z);
    const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    ref.current.quaternion.copy(parentQuat.invert().multiply(target));
  });
  return (
    <group ref={ref}>
      <mesh position={[0, h / 2, 0]} castShadow>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={sprite.texture} transparent alphaTest={0.08} side={THREE.DoubleSide} color={silhouette ? '#000000' : '#ffffff'} roughness={0.9} />
      </mesh>
    </group>
  );
}

function ShinySparkles() {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.8;
    ref.current.children.forEach((c, i) => {
      const s = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 4 + i * 1.7);
      c.scale.setScalar(s);
    });
  });
  return (
    <group ref={ref}>
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.75, 0.6 + (i % 3) * 0.3, Math.sin(a) * 0.75]}>
            <octahedronGeometry args={[0.06, 0]} />
            <meshStandardMaterial color="#fff6a0" emissive="#ffe14a" emissiveIntensity={2} />
          </mesh>
        );
      })}
    </group>
  );
}
