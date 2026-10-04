import { useFrame } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SUN_DIR } from './Sky';

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform float time;
  uniform vec3 shallow;
  uniform vec3 deep;
  uniform vec3 sunDir;
  uniform float lava;
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  float wave(vec2 p) {
    return sin(p.x * 1.3 + time * 1.1) * 0.5 + sin(p.y * 1.7 - time * 0.9) * 0.5 + sin((p.x + p.y) * 2.3 + time * 1.7) * 0.25;
  }
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    vec2 p = vWorld.xz * (lava > 0.5 ? 0.35 : 0.9);
    float e = 0.05;
    float h = wave(p);
    vec3 n = normalize(vec3(wave(p + vec2(e, 0.0)) - h, 1.6, wave(p + vec2(0.0, e)) - h));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0), 3.0);
    vec3 col = mix(deep, shallow, smoothstep(1.0, 0.55, r) * 0.0 + smoothstep(0.55, 1.0, r));
    col = mix(col, vec3(0.85, 0.93, 1.0), fres * 0.55 * (1.0 - lava));
    vec3 hv = normalize(sunDir + viewDir);
    float spec = pow(max(dot(n, hv), 0.0), 120.0);
    col += vec3(1.0, 0.97, 0.9) * spec * 1.4 * (1.0 - lava);
    float foam = smoothstep(0.86, 0.97, r + sin(atan(vUv.y - 0.5, vUv.x - 0.5) * 9.0 + time * 1.5) * 0.02);
    col = mix(col, vec3(1.0), foam * 0.8 * (1.0 - lava));
    if (lava > 0.5) {
      float glow = 0.5 + 0.5 * sin(p.x * 2.0 + time * 0.8) * sin(p.y * 1.7 - time * 0.6);
      col = mix(deep, shallow, glow) * (1.6 + glow);
    }
    gl_FragColor = vec4(col, lava > 0.5 ? 1.0 : mix(0.9, 0.98, fres));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const lavaTime = { value: 0 };

export function WaterDisc({ x, z, r, y, lava = false }: { x: number; z: number; r: number; y: number; lava?: boolean }) {
  const uniforms = useMemo(
    () => ({
      time: lavaTime,
      shallow: { value: new THREE.Color(lava ? '#ffb030' : '#4fd2ee') },
      deep: { value: new THREE.Color(lava ? '#c02a08' : '#1462c0') },
      sunDir: { value: SUN_DIR.clone() },
      lava: { value: lava ? 1 : 0 },
      ...THREE.UniformsLib.fog,
    }),
    [lava],
  );
  useFrame(({ clock }) => {
    lavaTime.value = clock.elapsedTime;
  });
  return (
    <group>
      <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow renderOrder={2}>
        <circleGeometry args={[r, 48]} />
        <shaderMaterial uniforms={uniforms} vertexShader={VERT} fragmentShader={FRAG} transparent={!lava} fog depthWrite={lava} />
      </mesh>
      {lava && <pointLight position={[x, y + 1.5, z]} color="#ff6a20" intensity={18} distance={r * 3} decay={1.6} />}
    </group>
  );
}
