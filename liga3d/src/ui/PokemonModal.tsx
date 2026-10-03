import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useState } from 'react';
import { getItem } from '../data/items';
import { getMove } from '../data/moves';
import { NATURE_BY_ID } from '../data/natures';
import { dexNo, getSpecies, STAT_KEYS, STAT_LABELS } from '../data/species';
import { TYPE_INFO } from '../data/types';
import { getLocation } from '../data/world';
import { deposit, moveInTeam, release, rename, useItem } from '../engine/actions';
import type { Pokemon } from '../engine/model';
import { calcStats, displayName, expProgress, ivPercent, maxHp } from '../engine/pokemon';
import { useStore } from '../state/store';
import { CreatureModel } from '../three/CreatureModel';
import { ExpBar, GenderMark, HpBar, Modal, StatusBadge, TypeBadge } from './common';

export function MonPreview({ species, shiny, height = 220 }: { species: number; shiny: boolean; height?: number }) {
  const useSprites = useStore((s) => s.settings.useSprites);
  return (
    <div className="mon-preview" style={{ height }}>
      <Canvas shadows dpr={[1, 2]} camera={{ position: [0, 1.4, 4], fov: 40 }} gl={{ preserveDrawingBuffer: true }}>
        <hemisphereLight args={['#dfe8ff', '#30304a', 1.2]} />
        <directionalLight position={[3, 5, 4]} intensity={2} castShadow />
        <CreatureModel speciesId={species} shiny={shiny} useSprites={useSprites} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[1.4, 32]} />
          <meshStandardMaterial color="#2a3048" />
        </mesh>
        <OrbitControls enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={1.5} target={[0, 0.7, 0]} minPolarAngle={1} maxPolarAngle={1.45} />
      </Canvas>
    </div>
  );
}

function StatTable({ p }: { p: Pokemon }) {
  const stats = calcStats(p);
  const nat = NATURE_BY_ID[p.nature];
  return (
    <table className="stat-table">
      <thead>
        <tr>
          <th />
          <th>Значение</th>
          <th title="Гены (IV), 0–31">Гены</th>
          <th title="Раскачка (EV), до 252">Раскачка</th>
        </tr>
      </thead>
      <tbody>
        {STAT_KEYS.map((k) => {
          const up = nat?.up === k;
          const down = nat?.down === k;
          return (
            <tr key={k}>
              <td className={up ? 'nat-up' : down ? 'nat-down' : ''}>
                {STAT_LABELS[k]}
                {up && ' ▲'}
                {down && ' ▼'}
              </td>
              <td>
                <div className="stat-bar">
                  <div style={{ width: `${Math.min(100, (stats[k] / (k === 'hp' ? 400 : 300)) * 100)}%` }} />
                  <span>{stats[k]}</span>
                </div>
              </td>
              <td>
                <span className={`iv${p.ivs[k] === 31 ? ' max' : p.ivs[k] >= 25 ? ' good' : ''}`}>{p.ivs[k]}</span>
              </td>
              <td>{p.evs[k]}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PokemonModal({ uid }: { uid: string }) {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const setModal = useStore((s) => s.setModal);
  const [nick, setNick] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const teamIndex = game.team.findIndex((p) => p.uid === uid);
  const p = game.team[teamIndex] ?? game.storage.find((x) => x.uid === uid);
  if (!p) return null;
  const sp = getSpecies(p.species);
  const inTeam = teamIndex >= 0;
  const close = () => setModal(null);
  const loc = getLocation(game.location);
  const usable = Object.entries(game.bag)
    .filter(([, n]) => n > 0)
    .map(([id]) => getItem(id))
    .filter((it) => ['heal', 'status', 'revive', 'pp', 'stone'].includes(it.kind));
  const exp = expProgress(p);

  return (
    <Modal title={<>{dexNo(sp.id)} {displayName(p)}</>} onClose={close} wide>
      <div className="mon-detail">
        <div className="mon-detail-left">
          <MonPreview species={p.species} shiny={p.shiny} />
          <div className="mon-detail-head">
            <div className="mon-line big">
              {p.shiny && <span className="shiny-star">✦</span>}
              <strong>{displayName(p)}</strong>
              {p.nickname && <span className="muted">({sp.name})</span>}
              <GenderMark gender={p.gender} />
              <span className="mon-level">ур. {p.level}</span>
            </div>
            <div className="hud-types">
              {sp.types.map((t) => (
                <TypeBadge key={t} type={t} />
              ))}
              <StatusBadge status={p.status} />
            </div>
            <HpBar hp={p.hp} max={maxHp(p)} />
            <ExpBar p={p} />
            <small className="muted">
              Опыт: {exp.current}/{exp.needed} до следующего уровня
            </small>
          </div>
          <dl className="facts">
            <dt>Характер</dt>
            <dd>{NATURE_BY_ID[p.nature]?.name ?? p.nature}</dd>
            <dt>Гены</dt>
            <dd>{ivPercent(p)}%</dd>
            <dt>Пойман</dt>
            <dd>
              {p.metAt || '—'}, ур. {p.metLevel}
            </dd>
            <dt>Покебол</dt>
            <dd>{getItem(p.ball).name}</dd>
          </dl>
        </div>
        <div className="mon-detail-right">
          <h4>Характеристики</h4>
          <StatTable p={p} />
          <h4>Атаки</h4>
          <div className="move-list">
            {p.moves.map((m) => {
              const mv = getMove(m.id);
              return (
                <div key={m.id} className="move-row" style={{ ['--type' as string]: TYPE_INFO[mv.type].color }}>
                  <span className="move-name">{mv.name}</span>
                  <TypeBadge type={mv.type} small />
                  <span className="muted">{mv.category === 'physical' ? 'Физ.' : mv.category === 'special' ? 'Спец.' : 'Статус'}</span>
                  <span>{mv.power || '—'}</span>
                  <span>{mv.accuracy ?? '∞'}%</span>
                  <span>
                    PP {m.pp}/{m.maxPp}
                  </span>
                </div>
              );
            })}
          </div>

          {!game.battle && (
            <div className="mon-actions">
              {nick === null ? (
                <button className="btn small" type="button" onClick={() => setNick(p.nickname ?? '')}>
                  ✎ Кличка
                </button>
              ) : (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act((g) => rename(g, uid, nick));
                    setNick(null);
                  }}
                >
                  <input value={nick} maxLength={16} autoFocus onChange={(e) => setNick(e.target.value)} placeholder={sp.name} />
                  <button className="btn small primary" type="submit">
                    OK
                  </button>
                </form>
              )}
              {inTeam && teamIndex > 0 && (
                <button className="btn small" type="button" onClick={() => act((g) => moveInTeam(g, teamIndex, 0))}>
                  ★ Сделать первым
                </button>
              )}
              {inTeam && loc.pokecenter && (
                <button className="btn small" type="button" onClick={() => (act((g) => deposit(g, uid)).ok ? close() : undefined)}>
                  В питомник
                </button>
              )}
              {!confirmRelease ? (
                <button className="btn small danger" type="button" onClick={() => setConfirmRelease(true)}>
                  Отпустить
                </button>
              ) : (
                <span className="confirm">
                  Точно отпустить?
                  <button className="btn small danger" type="button" onClick={() => (act((g) => release(g, uid)).ok ? close() : setConfirmRelease(false))}>
                    Да
                  </button>
                  <button className="btn small" type="button" onClick={() => setConfirmRelease(false)}>
                    Нет
                  </button>
                </span>
              )}
            </div>
          )}

          {!game.battle && inTeam && usable.length > 0 && (
            <>
              <h4>Использовать предмет</h4>
              <div className="item-grid">
                {usable.map((it) => (
                  <button key={it.id} className="item-btn" type="button" onClick={() => act((g) => useItem(g, it.id, uid))} title={it.desc}>
                    <span className="item-dot" style={{ background: it.icon }} />
                    <span>{it.name}</span>
                    <span className="count">×{game.bag[it.id]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
