import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useRef, useState } from 'react';
import { getSpecies } from '../data/species';
import { STARTERS } from '../engine/actions';
import { CreatureModel } from '../three/CreatureModel';
import { useStore } from '../state/store';
import { TypeBadge } from './common';

const BLURBS: Record<number, string> = {
  1: 'Спокойный и выносливый. Травяной и ядовитый тип — силён против воды и камня.',
  4: 'Горячий характер и огонь на хвосте. Огненный тип — силён против травы и насекомых.',
  7: 'Надёжный панцирь и водные атаки. Водный тип — силён против огня, земли и камня.',
};

function StarterStage({ selected, onSelect, useSprites }: { selected: number; onSelect: (id: number) => void; useSprites: boolean }) {
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [0, 2.6, 7.2], fov: 40 }} gl={{ preserveDrawingBuffer: true }}>
      <color attach="background" args={['#141826']} />
      <hemisphereLight args={['#c8d8ff', '#202030', 1]} />
      <directionalLight position={[4, 8, 5]} intensity={2.2} castShadow />
      <spotLight position={[0, 7, 2]} angle={0.5} penumbra={0.6} intensity={30} />
      {STARTERS.map((id, i) => {
        const x = (i - 1) * 2.6;
        const active = selected === id;
        return (
          <group key={id} position={[x, 0, 0]} onClick={(e) => (e.stopPropagation(), onSelect(id))}>
            <mesh position={[0, -0.1, 0]} receiveShadow>
              <cylinderGeometry args={[0.95, 1.05, 0.2, 24]} />
              <meshStandardMaterial color={active ? '#ffcf4a' : '#3a4060'} emissive={active ? '#ff9a2a' : '#000'} emissiveIntensity={active ? 0.35 : 0} />
            </mesh>
            <group rotation={[0, -x * 0.12, 0]}>
              <CreatureModel speciesId={id} anim={active ? 'attack' : 'idle'} animKey={active ? id : 0} scale={1.25} useSprites={useSprites} lunge={0.4} />
            </group>
          </group>
        );
      })}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]} receiveShadow>
        <circleGeometry args={[9, 40]} />
        <meshStandardMaterial color="#1c2133" />
      </mesh>
      <OrbitControls enablePan={false} enableZoom={false} minPolarAngle={1} maxPolarAngle={1.45} target={[0, 0.8, 0]} />
    </Canvas>
  );
}

export function TitleScreen() {
  const newGame = useStore((s) => s.newGame);
  const importSave = useStore((s) => s.importSave);
  const useSprites = useStore((s) => s.settings.useSprites);
  const [name, setName] = useState('');
  const [starter, setStarter] = useState(4);
  const fileRef = useRef<HTMLInputElement>(null);
  const sp = getSpecies(starter);

  return (
    <div className="title-screen">
      <div className="title-hero">
        <div className="logo">
          <span className="logo-ball" aria-hidden="true" />
          <div>
            <h1>Лига 3D</h1>
            <p>Покемоны, тренеры и приключения — в трёхмерном мире.</p>
          </div>
        </div>
        <div className="starter-stage">
          <StarterStage selected={starter} onSelect={setStarter} useSprites={useSprites} />
          <div className="stage-hint">Нажмите на покемона, чтобы выбрать. Сцену можно вращать.</div>
        </div>
      </div>
      <div className="title-panel">
        <h2>Новая игра</h2>
        <label className="field">
          <span>Имя тренера</span>
          <input value={name} maxLength={16} placeholder="Например, Ash" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="starter-choice">
          {STARTERS.map((id) => {
            const s = getSpecies(id);
            return (
              <button key={id} type="button" className={`starter-btn${starter === id ? ' active' : ''}`} onClick={() => setStarter(id)}>
                <span className="starter-name">{s.name}</span>
                <span>{s.types.map((t) => <TypeBadge key={t} type={t} small />)}</span>
              </button>
            );
          })}
        </div>
        <p className="starter-blurb">{BLURBS[starter]}</p>
        <button className="btn primary big" type="button" onClick={() => newGame(name || 'Тренер', starter)}>
          В путь! Стартовый покемон — {sp.name}
        </button>
        <div className="title-secondary">
          <button className="btn ghost" type="button" onClick={() => fileRef.current?.click()}>
            Загрузить сохранение из файла
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) importSave(await f.text());
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </div>
  );
}
