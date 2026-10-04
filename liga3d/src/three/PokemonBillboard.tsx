import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { getSpecies } from '../data/species';
import { usePokemonArt, worldHeight, type ArtSource } from './art';
import { CreatureModel, type CreatureAnim } from './CreatureModel';

const VERT = /* glsl */ `
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float flash;
  uniform float opacity;
  uniform float silhouette;
  uniform vec3 tint;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main() {
    vec4 c = texture2D(map, vUv);
    if (c.a < 0.08) discard;
    vec3 rgb = pow(c.rgb, vec3(2.2));
    rgb = mix(rgb, vec3(0.02, 0.03, 0.06), silhouette);
    rgb = mix(rgb, vec3(1.0), flash) * tint;
    gl_FragColor = vec4(rgb, c.a * opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

let blobTexture: THREE.Texture | null = null;
function getBlobTexture(): THREE.Texture {
  if (blobTexture) return blobTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}

export function BlobShadow({ radius, opacity = 1 }: { radius: number; opacity?: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={1}>
      <planeGeometry args={[radius * 2, radius * 2]} />
      <meshBasicMaterial map={getBlobTexture()} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  );
}

export interface PokemonBillboardProps {
  speciesId: number;
  shiny?: boolean;
  anim?: CreatureAnim;
  animKey?: number;
  /** Mirror the picture (Pokémon on the player's side face the opponent). */
  flip?: boolean;
  /** Multiplier on top of the real-size height. */
  scale?: number;
  minHeight?: number;
  silhouette?: boolean;
  bobSeed?: number;
  source?: ArtSource;
}

/** A Pokémon shown as a camera-facing HOME render standing on the ground, with battle animations. */
export function PokemonBillboard({
  speciesId, shiny = false, anim = 'idle', animKey = 0, flip = false, scale = 1, minHeight = 0.9, silhouette = false, bobSeed = 0, source,
}: PokemonBillboardProps) {
  const art = usePokemonArt(speciesId, shiny, source);
  const sp = getSpecies(speciesId);
  const height = worldHeight(sp.height, minHeight) * scale;

  if (art.status === 'none') {
    return (
      <group>
        <CreatureModel speciesId={speciesId} shiny={shiny} anim={anim} animKey={animKey} silhouette={silhouette} scale={Math.max(0.6, height / 1.3)} bobSeed={bobSeed} />
        <BlobShadow radius={0.6 * Math.max(0.6, height / 1.3)} />
      </group>
    );
  }
  if (art.status === 'loading') return <BlobShadow radius={0.3 * height} opacity={0.5} />;
  return (
    <Billboard
      texture={art.image.texture}
      aspect={art.image.aspect}
      height={height}
      flip={flip}
      anim={anim}
      animKey={animKey}
      silhouette={silhouette}
      bobSeed={bobSeed}
      shiny={shiny}
      floating={sp.types.includes('flying') || sp.types.includes('ghost')}
    />
  );
}

function Billboard({ texture, aspect, height, flip, anim, animKey, silhouette, bobSeed, shiny, floating }: {
  texture: THREE.Texture; aspect: number; height: number; flip: boolean; anim: CreatureAnim; animKey: number; silhouette: boolean; bobSeed: number; shiny: boolean; floating: boolean;
}) {
  const width = height * aspect;
  const outer = useRef<THREE.Group>(null);
  const yaw = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const start = useRef({ key: -1, t: 0 });
  const uniforms = useMemo(
    () => ({
      map: { value: texture },
      flash: { value: 0 },
      opacity: { value: 1 },
      silhouette: { value: silhouette ? 1 : 0 },
      tint: { value: new THREE.Color(1, 1, 1) },
      ...THREE.UniformsLib.fog,
    }),
    [texture, silhouette],
  );
  const lift = floating ? Math.min(0.6, height * 0.25) : 0;
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) }), []);

  useFrame(({ clock, camera }) => {
    const g = outer.current;
    const y = yaw.current;
    const m = body.current;
    if (!g || !y || !m) return;
    const t = clock.elapsedTime + bobSeed;
    if (start.current.key !== animKey) start.current = { key: animKey, t: clock.elapsedTime };
    const dt = clock.elapsedTime - start.current.t;
    let px = 0;
    let pz = 0;
    let py = lift + (floating ? Math.sin(t * 2) * 0.08 : 0);
    let sx = 1 + Math.sin(t * 2.4) * 0.012;
    let sy = 1 + Math.sin(t * 2.4 + 1.2) * 0.025;
    let flash = 0;
    let opacity = 1;
    switch (anim) {
      case 'attack': {
        const p = Math.min(1, dt / 0.45);
        pz = Math.sin(p * Math.PI) * 1.1;
        py += Math.sin(p * Math.PI) * 0.25;
        break;
      }
      case 'hit': {
        const p = Math.min(1, dt / 0.55);
        px = Math.sin(dt * 55) * 0.1 * (1 - p);
        flash = p < 1 && Math.floor(dt * 12) % 2 === 0 ? 0.85 : 0;
        break;
      }
      case 'faint': {
        const p = Math.min(1, dt / 0.75);
        py -= p * height * 0.6;
        sy *= 1 - p * 0.4;
        opacity = 1 - p;
        break;
      }
      case 'hidden':
        opacity = 0;
        break;
      case 'appear': {
        const p = Math.min(1, dt / 0.45);
        const k = 0.15 + 0.85 * (1 - (1 - p) ** 3);
        sx *= k;
        sy *= k;
        flash = (1 - p) * 0.9;
        break;
      }
      case 'capture': {
        const p = Math.min(1, dt / 0.4);
        sx *= 1 - p;
        sy *= 1 - p;
        flash = 1;
        opacity = 1 - p * 0.5;
        break;
      }
    }
    g.position.set(px, py, pz);
    // Face the camera around the vertical axis only, regardless of the parent rotation.
    y.getWorldPosition(tmp.v);
    const yawAngle = Math.atan2(camera.position.x - tmp.v.x, camera.position.z - tmp.v.z);
    tmp.q.setFromAxisAngle(tmp.up, yawAngle);
    y.parent!.getWorldQuaternion(tmp.q2);
    y.quaternion.copy(tmp.q2.invert().multiply(tmp.q));
    m.scale.set((flip ? -1 : 1) * sx, sy, 1);
    m.position.y = (height * sy) / 2;
    const mat = m.material as THREE.ShaderMaterial;
    mat.uniforms.flash.value = flash;
    mat.uniforms.opacity.value = opacity;
    m.visible = opacity > 0.01;
  });

  return (
    <group>
      <group ref={outer}>
        <group ref={yaw}>
          <mesh ref={body}>
            <planeGeometry args={[width, height]} />
            <shaderMaterial uniforms={uniforms} vertexShader={VERT} fragmentShader={FRAG} transparent fog side={THREE.DoubleSide} />
          </mesh>
          {shiny && !silhouette && <Sparkles height={height} />}
        </group>
      </group>
      <BlobShadow radius={Math.max(0.35, width * 0.42)} opacity={0.9} />
    </group>
  );
}

function Sparkles({ height }: { height: number }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    ref.current?.children.forEach((c, i) => {
      const s = 0.4 + 0.6 * Math.max(0, Math.sin(clock.elapsedTime * 3 + i * 1.9));
      c.scale.setScalar(s);
      c.rotation.z = clock.elapsedTime * 2 + i;
    });
  });
  return (
    <group ref={ref}>
      {Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * height * 0.45, height * (0.3 + (i % 3) * 0.25), 0.05]}>
            <octahedronGeometry args={[0.07 + height * 0.02, 0]} />
            <meshBasicMaterial color="#fff6a0" />
          </mesh>
        );
      })}
    </group>
  );
}
