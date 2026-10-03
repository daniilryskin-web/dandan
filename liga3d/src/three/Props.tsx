import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

type Vec = [number, number, number];

interface P {
  position: Vec;
  scale?: number;
  rotation?: number;
  color?: string;
}

function M({ color, emissive, intensity = 1, opacity = 1, flat = true, metal = 0 }: { color: string; emissive?: string; intensity?: number; opacity?: number; flat?: boolean; metal?: number }) {
  return (
    <meshStandardMaterial
      color={color}
      flatShading={flat}
      roughness={0.8}
      metalness={metal}
      emissive={emissive ?? '#000000'}
      emissiveIntensity={emissive ? intensity : 0}
      transparent={opacity < 1}
      opacity={opacity}
    />
  );
}

export function PineTree({ position, scale = 1, color = '#2f7a3f' }: P) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.18, 1, 6]} />
        <M color="#6b4a2f" />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, 1.2 + i * 0.65, 0]} castShadow>
          <coneGeometry args={[1 - i * 0.25, 1.2, 7]} />
          <M color={i === 2 ? new THREE.Color(color).offsetHSL(0, 0, 0.06).getStyle() : color} />
        </mesh>
      ))}
    </group>
  );
}

export function RoundTree({ position, scale = 1, color = '#4fa84a' }: P) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.6, 0]} castShadow>
        <cylinderGeometry args={[0.14, 0.2, 1.2, 6]} />
        <M color="#7a5232" />
      </mesh>
      <mesh position={[0, 1.65, 0]} castShadow>
        <icosahedronGeometry args={[0.9, 1]} />
        <M color={color} />
      </mesh>
      <mesh position={[0.45, 1.35, 0.2]} castShadow>
        <icosahedronGeometry args={[0.55, 1]} />
        <M color={color} />
      </mesh>
    </group>
  );
}

export function Rock({ position, scale = 1, rotation = 0, color = '#8a8580' }: P) {
  return (
    <mesh position={position} scale={[scale, scale * 0.7, scale]} rotation={[0.2, rotation, 0.1]} castShadow receiveShadow>
      <dodecahedronGeometry args={[0.6, 0]} />
      <M color={color} />
    </mesh>
  );
}

export function GrassTuft({ position, scale = 1, color = '#5fae3f' }: P) {
  return (
    <group position={position} scale={scale}>
      {[-0.12, 0, 0.12].map((x, i) => (
        <mesh key={i} position={[x, 0.18, (i - 1) * 0.05]} rotation={[0, 0, x * 2]}>
          <coneGeometry args={[0.06, 0.4, 3]} />
          <M color={color} />
        </mesh>
      ))}
    </group>
  );
}

export function Flower({ position, color = '#ff7aa8' }: P) {
  return (
    <group position={position}>
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.015, 0.015, 0.24, 4]} />
        <M color="#4f9a3a" />
      </mesh>
      <mesh position={[0, 0.26, 0]}>
        <icosahedronGeometry args={[0.07, 0]} />
        <M color={color} />
      </mesh>
    </group>
  );
}

export function House({ position, rotation = 0, color = '#f2e6d0', roof = '#c85a3a', scale = 1 }: P & { roof?: string }) {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      <mesh position={[0, 0.9, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 1.8, 2]} />
        <M color={color} />
      </mesh>
      <mesh position={[0, 2.35, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[2.05, 1.2, 4]} />
        <M color={roof} />
      </mesh>
      <mesh position={[0, 0.55, 1.01]}>
        <boxGeometry args={[0.55, 1.1, 0.05]} />
        <M color="#7a5232" />
      </mesh>
      {[-0.75, 0.75].map((x) => (
        <mesh key={x} position={[x, 1.15, 1.01]}>
          <boxGeometry args={[0.45, 0.4, 0.05]} />
          <M color="#bfe4ff" emissive="#9fd0ff" intensity={0.25} />
        </mesh>
      ))}
    </group>
  );
}

export function Pokecenter({ position, rotation = 0 }: P) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.2, 0]} castShadow receiveShadow>
        <boxGeometry args={[4, 2.4, 3]} />
        <M color="#f7f3ee" />
      </mesh>
      <mesh position={[0, 2.55, 0]} castShadow>
        <boxGeometry args={[4.3, 0.35, 3.3]} />
        <M color="#e53935" />
      </mesh>
      <mesh position={[0, 0.7, 1.51]}>
        <boxGeometry args={[1.3, 1.4, 0.05]} />
        <M color="#9fd8ff" emissive="#7fc8ff" intensity={0.4} />
      </mesh>
      <group position={[0, 3.25, 0]}>
        <mesh>
          <boxGeometry args={[1, 1, 0.25]} />
          <M color="#ffffff" />
        </mesh>
        <mesh position={[0, 0, 0.14]}>
          <boxGeometry args={[0.7, 0.2, 0.02]} />
          <M color="#e53935" emissive="#ff3030" intensity={0.6} />
        </mesh>
        <mesh position={[0, 0, 0.14]}>
          <boxGeometry args={[0.2, 0.7, 0.02]} />
          <M color="#e53935" emissive="#ff3030" intensity={0.6} />
        </mesh>
      </group>
    </group>
  );
}

export function Shop({ position, rotation = 0 }: P) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1, 0]} castShadow receiveShadow>
        <boxGeometry args={[3, 2, 2.4]} />
        <M color="#eef3f8" />
      </mesh>
      <mesh position={[0, 2.2, 0]} castShadow>
        <boxGeometry args={[3.3, 0.35, 2.7]} />
        <M color="#3a7bd5" />
      </mesh>
      <mesh position={[0, 0.65, 1.21]}>
        <boxGeometry args={[1, 1.3, 0.05]} />
        <M color="#bfe4ff" emissive="#9fd0ff" intensity={0.3} />
      </mesh>
      <mesh position={[0, 1.65, 1.22]}>
        <boxGeometry args={[2.2, 0.35, 0.05]} />
        <M color="#3a7bd5" emissive="#2a6bc5" intensity={0.4} />
      </mesh>
    </group>
  );
}

export function Gym({ position, rotation = 0 }: P) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.4, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2.6, 2.8, 2.8, 10]} />
        <M color="#c9c2b6" />
      </mesh>
      <mesh position={[0, 3.1, 0]} castShadow>
        <cylinderGeometry args={[0.4, 2.9, 0.9, 10]} />
        <M color="#7a6a5a" />
      </mesh>
      <mesh position={[0, 0.8, 2.62]}>
        <boxGeometry args={[1.2, 1.6, 0.1]} />
        <M color="#4a3a2a" />
      </mesh>
      <mesh position={[0, 3.8, 0]}>
        <octahedronGeometry args={[0.4, 0]} />
        <M color="#ffd54f" emissive="#ffb300" intensity={0.8} metal={0.4} />
      </mesh>
    </group>
  );
}

export function Fence({ position, rotation = 0, length = 3 }: P & { length?: number }) {
  const posts = Math.max(2, Math.round(length / 0.8) + 1);
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {Array.from({ length: posts }, (_, i) => (
        <mesh key={i} position={[-length / 2 + (i * length) / (posts - 1), 0.3, 0]} castShadow>
          <boxGeometry args={[0.1, 0.6, 0.1]} />
          <M color="#c49a6c" />
        </mesh>
      ))}
      {[0.22, 0.45].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[length, 0.06, 0.05]} />
          <M color="#c49a6c" />
        </mesh>
      ))}
    </group>
  );
}

export function Crystal({ position, scale = 1, color = '#8a6aff' }: P) {
  const ref = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.emissiveIntensity = 0.8 + Math.sin(clock.elapsedTime * 2 + position[0]) * 0.4;
  });
  return (
    <group position={position} scale={scale}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[(i - 1) * 0.18, 0.35 + (i % 2) * 0.1, 0]} rotation={[0, i, (i - 1) * 0.35]}>
          <octahedronGeometry args={[0.25, 0]} />
          <meshStandardMaterial ref={i === 1 ? ref : undefined} color={color} emissive={color} emissiveIntensity={0.9} flatShading transparent opacity={0.85} />
        </mesh>
      ))}
      <pointLight position={[0, 0.6, 0]} color={color} intensity={2} distance={4} />
    </group>
  );
}

export function LavaPool({ position, scale = 1 }: P) {
  const ref = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.emissiveIntensity = 1.2 + Math.sin(clock.elapsedTime * 1.6 + position[2]) * 0.4;
  });
  return (
    <group position={position} scale={scale}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <circleGeometry args={[1.2, 10]} />
        <meshStandardMaterial ref={ref} color="#ff7a1a" emissive="#ff4a00" emissiveIntensity={1.3} flatShading />
      </mesh>
      <pointLight position={[0, 0.6, 0]} color="#ff6a20" intensity={3} distance={5} />
    </group>
  );
}

export function Volcano({ position }: P) {
  return (
    <group position={position}>
      <mesh position={[0, 4, 0]} castShadow>
        <cylinderGeometry args={[1.6, 7, 8, 9]} />
        <M color="#4a2e28" />
      </mesh>
      <mesh position={[0, 8.05, 0]}>
        <cylinderGeometry args={[1.4, 1.4, 0.1, 9]} />
        <meshStandardMaterial color="#ff8a2a" emissive="#ff5a00" emissiveIntensity={2} />
      </mesh>
      <Smoke position={[0, 9, 0]} />
    </group>
  );
}

function Smoke({ position }: P) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    ref.current?.children.forEach((c, i) => {
      const t = (clock.elapsedTime * 0.3 + i / 5) % 1;
      c.position.set(Math.sin(i * 2 + t * 2) * 0.6, t * 5, Math.cos(i) * 0.4);
      c.scale.setScalar(0.6 + t * 1.8);
      ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0.45 * (1 - t);
    });
  });
  return (
    <group ref={ref} position={position}>
      {Array.from({ length: 5 }, (_, i) => (
        <mesh key={i}>
          <icosahedronGeometry args={[0.8, 1]} />
          <meshStandardMaterial color="#6a5a5a" transparent opacity={0.4} depthWrite={false} flatShading />
        </mesh>
      ))}
    </group>
  );
}

export function Pylon({ position, rotation = 0 }: P) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {[-0.4, 0.4].map((x) => (
        <mesh key={x} position={[x, 2.5, 0]} rotation={[0, 0, x * -0.12]} castShadow>
          <boxGeometry args={[0.12, 5, 0.12]} />
          <M color="#5a5e66" metal={0.5} />
        </mesh>
      ))}
      {[1.5, 3, 4.4].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[y > 4 ? 2.2 : 1, 0.1, 0.1]} />
          <M color="#5a5e66" metal={0.5} />
        </mesh>
      ))}
    </group>
  );
}

export function Building({ position, rotation = 0, scale = 1 }: P) {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      <mesh position={[0, 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[4, 4, 3]} />
        <M color="#8a8e96" />
      </mesh>
      <mesh position={[1.2, 5, 0.5]} castShadow>
        <cylinderGeometry args={[0.35, 0.45, 2.5, 8]} />
        <M color="#6a6e76" />
      </mesh>
      {[-1.2, 0, 1.2].map((x) =>
        [1.4, 2.8].map((y) => (
          <mesh key={`${x}${y}`} position={[x, y, 1.51]}>
            <boxGeometry args={[0.6, 0.5, 0.04]} />
            <M color="#3a3e46" emissive={(x + y) % 2 > 0.5 ? '#ffe680' : undefined} intensity={0.5} />
          </mesh>
        )),
      )}
    </group>
  );
}

export function Sparks({ position }: P) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    ref.current?.children.forEach((c, i) => {
      c.visible = Math.sin(clock.elapsedTime * 13 + i * 7) > 0.6;
    });
  });
  return (
    <group ref={ref} position={position}>
      {Array.from({ length: 4 }, (_, i) => (
        <mesh key={i} position={[(i - 1.5) * 0.25, Math.sin(i) * 0.2, 0]}>
          <octahedronGeometry args={[0.08, 0]} />
          <meshStandardMaterial color="#fff36a" emissive="#ffe14a" emissiveIntensity={3} />
        </mesh>
      ))}
    </group>
  );
}

export function Windmill({ position, rotation = 0 }: P) {
  const blades = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (blades.current) blades.current.rotation.z += dt * 0.8;
  });
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 2, 0]} castShadow>
        <cylinderGeometry args={[0.6, 1, 4, 8]} />
        <M color="#f2e6d0" />
      </mesh>
      <mesh position={[0, 4.4, 0]} castShadow>
        <coneGeometry args={[0.9, 1, 8]} />
        <M color="#b8603a" />
      </mesh>
      <group ref={blades} position={[0, 3.6, 0.9]}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} rotation={[0, 0, (i * Math.PI) / 2]} position={[0, 0, 0]}>
            <boxGeometry args={[0.3, 3.2, 0.05]} />
            <M color="#e8dcc4" />
          </mesh>
        ))}
      </group>
    </group>
  );
}

export function Reed({ position }: P) {
  return (
    <group position={position}>
      {[-0.08, 0.05, 0.12].map((x, i) => (
        <group key={i} position={[x, 0, i * 0.05]}>
          <mesh position={[0, 0.45, 0]}>
            <cylinderGeometry args={[0.015, 0.02, 0.9, 4]} />
            <M color="#6a9a4a" />
          </mesh>
          <mesh position={[0, 0.85, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 0.2, 5]} />
            <M color="#7a4a2a" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Water({ position, radius = 6 }: P & { radius?: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = position[1] + Math.sin(clock.elapsedTime * 0.8) * 0.03;
  });
  return (
    <mesh ref={ref} position={position} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[radius, 28]} />
      <meshStandardMaterial color="#3f9fe0" transparent opacity={0.82} roughness={0.15} metalness={0.2} />
    </mesh>
  );
}

export function Dock({ position, rotation = 0 }: P) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.2, 0.12, 3.2]} />
        <M color="#a87a4a" />
      </mesh>
      {[-1.4, 0, 1.4].map((z) =>
        [-0.5, 0.5].map((x) => (
          <mesh key={`${x}${z}`} position={[x, -0.2, z]}>
            <cylinderGeometry args={[0.07, 0.07, 0.8, 5]} />
            <M color="#7a5232" />
          </mesh>
        )),
      )}
    </group>
  );
}

export function Mushroom({ position, scale = 1, color = '#e0402f' }: P) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.05, 0.07, 0.24, 5]} />
        <M color="#f4ead6" />
      </mesh>
      <mesh position={[0, 0.25, 0]}>
        <sphereGeometry args={[0.16, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <M color={color} />
      </mesh>
    </group>
  );
}

export function Log({ position, rotation = 0 }: P) {
  return (
    <mesh position={position} rotation={[0, rotation, Math.PI / 2]} castShadow>
      <cylinderGeometry args={[0.25, 0.25, 2, 7]} />
      <M color="#7a5232" />
    </mesh>
  );
}

export function Lamp({ position }: P) {
  return (
    <group position={position}>
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[0.05, 0.07, 2.4, 6]} />
        <M color="#3a3e46" metal={0.4} />
      </mesh>
      <mesh position={[0, 2.45, 0]}>
        <icosahedronGeometry args={[0.18, 1]} />
        <meshStandardMaterial color="#fff6c8" emissive="#ffe08a" emissiveIntensity={1.4} />
      </mesh>
    </group>
  );
}
