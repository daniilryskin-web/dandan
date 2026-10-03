import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

/** Small low-poly trainer avatar. */
export function Trainer({ position, rotation = 0, jacket = '#e53935', cap = '#e53935' }: { position: [number, number, number]; rotation?: number; jacket?: string; cap?: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = position[1] + Math.abs(Math.sin(clock.elapsedTime * 1.8)) * 0.02;
  });
  return (
    <group ref={ref} position={position} rotation={[0, rotation, 0]}>
      {[-0.13, 0.13].map((x) => (
        <mesh key={x} position={[x, 0.32, 0]} castShadow>
          <cylinderGeometry args={[0.09, 0.08, 0.64, 6]} />
          <meshStandardMaterial color="#2f4a7a" flatShading />
        </mesh>
      ))}
      <mesh position={[0, 0.92, 0]} castShadow>
        <cylinderGeometry args={[0.27, 0.24, 0.62, 7]} />
        <meshStandardMaterial color={jacket} flatShading />
      </mesh>
      <mesh position={[0, 0.95, -0.25]} castShadow>
        <boxGeometry args={[0.36, 0.42, 0.16]} />
        <meshStandardMaterial color="#f2c94c" flatShading />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.33, 0.92, 0]} rotation={[0, 0, s * 0.2]} castShadow>
          <cylinderGeometry args={[0.07, 0.07, 0.55, 6]} />
          <meshStandardMaterial color={jacket} flatShading />
        </mesh>
      ))}
      <mesh position={[0, 1.42, 0]} castShadow>
        <icosahedronGeometry args={[0.24, 1]} />
        <meshStandardMaterial color="#f6d2b0" flatShading />
      </mesh>
      <mesh position={[0, 1.55, 0]} castShadow>
        <sphereGeometry args={[0.26, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={cap} flatShading />
      </mesh>
      <mesh position={[0, 1.55, 0.2]} rotation={[0.1, 0, 0]}>
        <boxGeometry args={[0.36, 0.04, 0.24]} />
        <meshStandardMaterial color={cap} flatShading />
      </mesh>
      {[-0.08, 0.08].map((x) => (
        <mesh key={x} position={[x, 1.44, 0.21]}>
          <icosahedronGeometry args={[0.03, 0]} />
          <meshStandardMaterial color="#1d1d24" />
        </mesh>
      ))}
    </group>
  );
}
