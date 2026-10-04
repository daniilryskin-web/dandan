import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Biome } from '../../data/world';

export interface SkyLook {
  top: string;
  horizon: string;
  fog: string;
  sun: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  ambient: number;
  clouds: number;
  fogNear: number;
  fogFar: number;
}

export const SKIES: Record<Biome, SkyLook> = {
  town: { top: '#3d8fe6', horizon: '#bfe3ff', fog: '#cfe8ff', sun: '#fff1d6', sunIntensity: 3.1, hemiSky: '#d6ecff', hemiGround: '#6f8f4a', ambient: 0.55, clouds: 16, fogNear: 60, fogFar: 190 },
  meadow: { top: '#3a8ce8', horizon: '#c4e6ff', fog: '#d2ecff', sun: '#fff1d6', sunIntensity: 3.2, hemiSky: '#d6ecff', hemiGround: '#6a8f45', ambient: 0.55, clouds: 18, fogNear: 60, fogFar: 190 },
  forest: { top: '#4a93d6', horizon: '#cfe8d8', fog: '#bfdcc4', sun: '#fff4d8', sunIntensity: 2.6, hemiSky: '#cfe8d0', hemiGround: '#3a5a30', ambient: 0.5, clouds: 12, fogNear: 30, fogFar: 130 },
  mountain: { top: '#3f86d8', horizon: '#d8e8f6', fog: '#dde9f4', sun: '#ffffff', sunIntensity: 3.2, hemiSky: '#e0ecff', hemiGround: '#6a6050', ambient: 0.55, clouds: 20, fogNear: 50, fogFar: 200 },
  cave: { top: '#0c0a14', horizon: '#1c1828', fog: '#16121f', sun: '#b8a8ff', sunIntensity: 0.55, hemiSky: '#6a5a9a', hemiGround: '#141018', ambient: 0.4, clouds: 0, fogNear: 12, fogFar: 60 },
  lake: { top: '#3a90ea', horizon: '#c8eaff', fog: '#d6f0ff', sun: '#fff4dc', sunIntensity: 3.2, hemiSky: '#d6f2ff', hemiGround: '#5a8a4a', ambient: 0.55, clouds: 16, fogNear: 60, fogFar: 190 },
  volcano: { top: '#5a2a3a', horizon: '#f0905a', fog: '#b0604a', sun: '#ffb070', sunIntensity: 2.4, hemiSky: '#ffb88a', hemiGround: '#3a1a14', ambient: 0.45, clouds: 8, fogNear: 25, fogFar: 120 },
  plant: { top: '#5f6f8a', horizon: '#b8c0cc', fog: '#a8b0bc', sun: '#e8eeff', sunIntensity: 2.0, hemiSky: '#c0c8d8', hemiGround: '#3a3e44', ambient: 0.55, clouds: 22, fogNear: 35, fogFar: 140 },
  hills: { top: '#3b8fea', horizon: '#c8eaff', fog: '#e0f4ff', sun: '#fff1d6', sunIntensity: 3.2, hemiSky: '#e4f6ff', hemiGround: '#6a9a4a', ambient: 0.6, clouds: 18, fogNear: 60, fogFar: 200 },
};

export const SUN_DIR = new THREE.Vector3(0.45, 0.75, 0.35).normalize();

export function SkyDome({ biome }: { biome: Biome }) {
  const look = SKIES[biome];
  const uniforms = useMemo(
    () => ({
      top: { value: new THREE.Color(look.top) },
      horizon: { value: new THREE.Color(look.horizon) },
      sunDir: { value: SUN_DIR.clone() },
      sunColor: { value: new THREE.Color(look.sun) },
      night: { value: biome === 'cave' ? 1 : 0 },
    }),
    [look, biome],
  );
  return (
    <mesh scale={450} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[1, 32, 16]} />
      <shaderMaterial
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
        uniforms={uniforms}
        vertexShader={/* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`}
        fragmentShader={/* glsl */ `
          uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float night;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, -0.2, 1.0);
            vec3 col = mix(horizon, top, pow(max(h, 0.0), 0.55));
            col = mix(col, horizon * 0.85, smoothstep(0.0, -0.2, h));
            float s = max(dot(normalize(vDir), sunDir), 0.0);
            col += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.25) * (1.0 - night);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`}
      />
    </mesh>
  );
}

let cloudTex: THREE.Texture | null = null;
function cloudTexture(): THREE.Texture {
  if (cloudTex) return cloudTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const puffs: [number, number, number][] = [[60, 80, 34], [100, 62, 44], [150, 70, 40], [190, 84, 30], [128, 88, 36], [84, 92, 28], [170, 94, 26]];
  for (const [x, y, r] of puffs) {
    const g = ctx.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.65, 'rgba(250,252,255,0.9)');
    g.addColorStop(1, 'rgba(235,242,252,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  cloudTex = new THREE.CanvasTexture(c);
  cloudTex.colorSpace = THREE.SRGBColorSpace;
  return cloudTex;
}

export function Clouds({ count, seed }: { count: number; seed: number }) {
  const group = useRef<THREE.Group>(null);
  const clouds = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const a = ((seed % 100) / 100 + i / count) * Math.PI * 2 + Math.sin(i * 12.9) * 0.3;
        const r = 150 + ((i * 37) % 90);
        return { x: Math.cos(a) * r, z: Math.sin(a) * r, y: 55 + ((i * 23) % 40), s: 40 + ((i * 53) % 50), speed: 0.4 + ((i * 7) % 5) * 0.12 };
      }),
    [count, seed],
  );
  useFrame(({ camera }, dt) => {
    const g = group.current;
    if (!g) return;
    g.children.forEach((c, i) => {
      c.position.x += clouds[i].speed * dt;
      if (c.position.x > 260) c.position.x = -260;
      c.lookAt(camera.position.x, c.position.y, camera.position.z);
    });
  });
  return (
    <group ref={group}>
      {clouds.map((c, i) => (
        <mesh key={i} position={[c.x, c.y, c.z]} renderOrder={-5}>
          <planeGeometry args={[c.s, c.s * 0.5]} />
          <meshBasicMaterial map={cloudTexture()} transparent depthWrite={false} fog={false} opacity={0.95} />
        </mesh>
      ))}
    </group>
  );
}
