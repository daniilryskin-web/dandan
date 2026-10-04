import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

export interface AvatarColors {
  shirt: string;
  pants: string;
  cap: string;
  bag: string;
  skin: string;
  hair: string;
}

export const PLAYER_COLORS: AvatarColors = { shirt: '#f6f1e6', pants: '#2c3e70', cap: '#e8473a', bag: '#f2b632', skin: '#f3cfae', hair: '#5a3826' };

function Mat({ color, rough = 0.7 }: { color: string; rough?: number }) {
  return <meshStandardMaterial color={color} roughness={rough} />;
}

/** Stylised trainer with a walk cycle. `speed` (units/s) drives the animation; `getSpeed` lets it read live values. */
export function Avatar({ colors = PLAYER_COLORS, getSpeed, wave = false }: { colors?: AvatarColors; getSpeed?: () => number; wave?: boolean }) {
  const body = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const phase = useRef(0);
  useFrame(({ clock }, dt) => {
    const speed = getSpeed ? getSpeed() : 0;
    const moving = Math.min(1, speed / 4);
    phase.current += dt * (4 + speed * 1.6) * (moving > 0.05 ? 1 : 0);
    const s = Math.sin(phase.current);
    const swing = 0.75 * moving;
    if (legL.current) legL.current.rotation.x = s * swing;
    if (legR.current) legR.current.rotation.x = -s * swing;
    if (armL.current) armL.current.rotation.x = -s * swing * 0.9;
    if (armR.current) armR.current.rotation.x = wave ? -2.6 + Math.sin(clock.elapsedTime * 6) * 0.3 : s * swing * 0.9;
    if (body.current) {
      body.current.position.y = Math.abs(Math.cos(phase.current)) * 0.06 * moving + Math.sin(clock.elapsedTime * 1.6) * 0.01;
      body.current.rotation.x = moving * 0.12;
    }
  });
  return (
    <group ref={body}>
      {[
        [legL, -0.11],
        [legR, 0.11],
      ].map(([ref, x], i) => (
        <group key={i} ref={ref as React.RefObject<THREE.Group>} position={[x as number, 0.78, 0]}>
          <mesh position={[0, -0.3, 0]} castShadow>
            <capsuleGeometry args={[0.085, 0.42, 4, 10]} />
            <Mat color={colors.pants} />
          </mesh>
          <mesh position={[0, -0.72, 0.05]} castShadow>
            <boxGeometry args={[0.16, 0.1, 0.27]} />
            <Mat color="#f2f2f2" rough={0.5} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.96, 0]} castShadow>
        <capsuleGeometry args={[0.22, 0.34, 6, 14]} />
        <Mat color={colors.shirt} />
      </mesh>
      <mesh position={[0, 0.82, 0]} castShadow>
        <cylinderGeometry args={[0.235, 0.235, 0.12, 14]} />
        <Mat color={colors.pants} />
      </mesh>
      <group position={[0, 1.0, -0.24]}>
        <mesh castShadow>
          <boxGeometry args={[0.38, 0.42, 0.18]} />
          <Mat color={colors.bag} rough={0.5} />
        </mesh>
        <mesh position={[0, 0.12, -0.095]}>
          <boxGeometry args={[0.28, 0.12, 0.02]} />
          <Mat color="#ffffff" />
        </mesh>
      </group>
      {[
        [armL, -0.31],
        [armR, 0.31],
      ].map(([ref, x], i) => (
        <group key={i} ref={ref as React.RefObject<THREE.Group>} position={[x as number, 1.2, 0]}>
          <mesh position={[0, -0.22, 0]} castShadow>
            <capsuleGeometry args={[0.065, 0.32, 4, 8]} />
            <Mat color={colors.shirt} />
          </mesh>
          <mesh position={[0, -0.47, 0]}>
            <sphereGeometry args={[0.065, 10, 8]} />
            <Mat color={colors.skin} />
          </mesh>
        </group>
      ))}
      <group position={[0, 1.55, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.24, 20, 16]} />
          <Mat color={colors.skin} rough={0.6} />
        </mesh>
        <mesh position={[0, 0.03, -0.04]} scale={[1.04, 1, 1.02]}>
          <sphereGeometry args={[0.245, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
          <Mat color={colors.hair} />
        </mesh>
        <mesh position={[0, 0.1, 0]}>
          <sphereGeometry args={[0.258, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <Mat color={colors.cap} rough={0.5} />
        </mesh>
        <mesh position={[0, 0.11, 0.2]} rotation={[0.12, 0, 0]}>
          <cylinderGeometry args={[0.17, 0.17, 0.025, 20, 1, false, -Math.PI / 2, Math.PI]} />
          <Mat color={colors.cap} rough={0.5} />
        </mesh>
        <mesh position={[0, 0.2, 0.21]}>
          <circleGeometry args={[0.055, 16]} />
          <meshStandardMaterial color="#ffffff" />
        </mesh>
        {[-0.085, 0.085].map((x) => (
          <mesh key={x} position={[x, -0.01, 0.22]}>
            <sphereGeometry args={[0.03, 10, 8]} />
            <meshStandardMaterial color="#1d2030" roughness={0.3} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
