import { useMemo } from 'react';
import { getSpecies } from '../data/species';
import { BADGES, BIOME_LABELS, getLocation, type Encounter } from '../data/world';
import { bestRod, canEnter, challenge, explore, fish, healAtCenter, travel, trainersHere } from '../engine/actions';
import { defaultRng } from '../engine/rng';
import { useStore } from '../state/store';
import { LocationScene } from '../three/LocationScene';
import { MonIcon } from './common';

function rarity(pct: number): { label: string; cls: string } {
  if (pct >= 15) return { label: 'Часто', cls: 'common' };
  if (pct >= 6) return { label: 'Иногда', cls: 'uncommon' };
  if (pct >= 2) return { label: 'Редко', cls: 'rare' };
  return { label: 'Очень редко', cls: 'very-rare' };
}

function EncounterList({ title, list, dex }: { title: string; list: Encounter[]; dex: Record<number, 'seen' | 'caught'> }) {
  const total = list.reduce((s, e) => s + e.weight, 0);
  return (
    <div className="encounters">
      <h4>{title}</h4>
      <ul>
        {list.map((e, i) => {
          const pct = (e.weight / total) * 100;
          const seen = !!dex[e.species];
          const r = rarity(pct);
          return (
            <li key={`${e.species}-${i}`} title={`${pct.toFixed(1)}%`}>
              <MonIcon species={e.species} size={32} silhouette={!seen} />
              <span className="enc-name">
                {seen ? getSpecies(e.species).name : '???'}
                {dex[e.species] === 'caught' && <span className="caught-dot" title="Пойман" />}
              </span>
              <span className="enc-lvl">ур. {e.min === e.max ? e.min : `${e.min}–${e.max}`}</span>
              <span className={`rarity ${r.cls}`}>{r.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LocationView() {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const setModal = useStore((s) => s.setModal);
  const useSprites = useStore((s) => s.settings.useSprites);
  const loc = getLocation(game.location);
  const trainers = trainersHere(game);
  const lead = game.team.find((p) => p.hp > 0) ?? game.team[0];

  const wild = useMemo(() => {
    const ids = [...new Set((loc.wild ?? []).map((e) => e.species))];
    return ids.map((species) => ({ species, seen: !!game.dex[species] }));
  }, [loc, game.dex]);

  const blocked = game.pendingEvolution.length > 0 || game.pendingLearn.length > 0;
  const rod = bestRod(game);

  return (
    <div className="location-view">
      <div className="scene-wrap">
        <LocationScene key={loc.id} location={loc} wild={wild} lead={lead ? { species: lead.species, shiny: lead.shiny } : null} useSprites={useSprites} />
        <div className="scene-title">
          <span className="biome-chip">{BIOME_LABELS[loc.biome]}</span>
          <h2>{loc.name}</h2>
          <p>{loc.description}</p>
        </div>
        <div className="scene-actions">
          {loc.wild?.length || loc.loot?.length ? (
            <button className="btn primary" type="button" disabled={blocked} onClick={() => act((g) => explore(g, defaultRng))}>
              🔍 Исследовать
            </button>
          ) : null}
          {loc.fishing && (
            <button className="btn" type="button" disabled={blocked} onClick={() => act((g) => fish(g, defaultRng))} title={rod ? '' : 'Нужна удочка'}>
              🎣 Рыбачить{rod === 2 ? ' (хорошая удочка)' : rod === 1 ? '' : ' — нет удочки'}
            </button>
          )}
          {loc.pokecenter && (
            <>
              <button className="btn heal" type="button" onClick={() => act(healAtCenter)}>
                ✚ Покецентр
              </button>
              <button className="btn" type="button" onClick={() => setModal('storage')}>
                Питомник
              </button>
            </>
          )}
          {loc.shop && (
            <button className="btn" type="button" onClick={() => setModal('shop')}>
              🛒 Магазин
            </button>
          )}
        </div>
      </div>

      <div className="location-panels">
        <div className="panel">
          <h3>Переходы</h3>
          <div className="exits">
            {loc.exits.map((id) => {
              const dest = getLocation(id);
              const open = canEnter(game, id);
              return (
                <button key={id} type="button" className={`exit-btn${open ? '' : ' locked'}`} onClick={() => act((g) => travel(g, id))}>
                  <span className="exit-arrow">➜</span>
                  <span>
                    <strong>{dest.name}</strong>
                    <small>
                      {BIOME_LABELS[dest.biome]}
                      {!open && dest.requiresBadge ? ` · 🔒 ${BADGES[dest.requiresBadge].name}` : ''}
                    </small>
                  </span>
                </button>
              );
            })}
            <button type="button" className="exit-btn map" onClick={() => setModal('map')}>
              <span className="exit-arrow">🗺</span>
              <span>
                <strong>Карта региона</strong>
                <small>Все локации</small>
              </span>
            </button>
          </div>
        </div>

        {trainers.length > 0 && (
          <div className="panel">
            <h3>Тренеры</h3>
            <div className="trainers">
              {trainers.map(({ trainer, defeated, gym }) => (
                <div key={trainer.id} className={`trainer-row${gym ? ' gym' : ''}${defeated ? ' defeated' : ''}`}>
                  <div>
                    <strong>
                      {gym && '🏟 '}
                      {trainer.title} {trainer.name}
                    </strong>
                    <small>
                      Покемонов: {trainer.team.length} · ур. до {Math.max(...trainer.team.map((m) => m.level))}
                      {gym && trainer.badge ? ` · награда: ${BADGES[trainer.badge].name}` : ` · награда: ${trainer.reward}`}
                    </small>
                  </div>
                  {defeated ? (
                    <span className="done-chip">Побеждён</span>
                  ) : (
                    <button className="btn small" type="button" disabled={blocked} onClick={() => act((g) => challenge(g, trainer.id, defaultRng))}>
                      Бой
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {loc.wild?.length || loc.fishing ? (
          <div className="panel">
            <h3>Здесь обитают</h3>
            {loc.wild?.length ? <EncounterList title="В траве" list={loc.wild} dex={game.dex} /> : null}
            {loc.fishing && <EncounterList title={rod === 2 ? 'На хорошую удочку' : 'На удочку'} list={rod === 2 ? loc.fishing.good : loc.fishing.old} dex={game.dex} />}
          </div>
        ) : null}
      </div>
    </div>
  );
}
