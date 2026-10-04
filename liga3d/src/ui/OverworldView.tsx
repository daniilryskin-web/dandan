import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getItem } from '../data/items';
import { getSpecies } from '../data/species';
import { BADGES, BIOME_LABELS, getLocation } from '../data/world';
import { bestRod, canEnter, challenge, encounterWild, fish, healAtCenter, pickupItem, travel, trainersHere } from '../engine/actions';
import { displayName, maxHp } from '../engine/pokemon';
import { defaultRng } from '../engine/rng';
import { useStore } from '../state/store';
import { input, runtime, useWorld, type Prompt } from '../state/world';
import { getLayout, type Layout } from '../three/world/layout';
import { Overworld, type OverworldHandlers } from '../three/world/Overworld';
import { hpColor, MonIcon } from './common';

/** Remembers where the battle starts so the arena is built on that spot, facing the opponent. */
function markBattleSpot(tx?: number, tz?: number) {
  const p = runtime.player;
  const dir = tx === undefined || tz === undefined ? p.rot : Math.atan2(tx - p.x, tz - p.z);
  runtime.battleSpot = { loc: runtime.loc, x: p.x, z: p.z, dir };
}

function Joystick() {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<[number, number]>([0, 0]);
  const active = useRef<number | null>(null);
  const update = (e: React.PointerEvent) => {
    const el = base.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    input.joy.x = x;
    input.joy.y = y;
    input.target = null;
    setKnob([x, y]);
  };
  const end = () => {
    active.current = null;
    input.joy.x = 0;
    input.joy.y = 0;
    setKnob([0, 0]);
  };
  return (
    <div
      ref={base}
      className="joystick"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => active.current === e.pointerId && update(e)}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div className="joystick-knob" style={{ transform: `translate(${knob[0] * 34}px, ${knob[1] * 34}px)` }} />
    </div>
  );
}

function PromptCard({ prompt }: { prompt: Prompt }) {
  useEffect(() => {
    const id = setInterval(() => {
      if (input.interact) {
        input.interact = false;
        (prompt.actions.find((a) => a.primary) ?? prompt.actions[0])?.run();
      }
    }, 60);
    return () => clearInterval(id);
  }, [prompt]);
  return (
    <div className="world-prompt">
      <div className="wp-title">
        <strong>{prompt.title}</strong>
        {prompt.subtitle && <small>{prompt.subtitle}</small>}
      </div>
      <div className="wp-actions">
        {prompt.actions.map((a, i) => (
          <button key={a.label} type="button" className={`btn ${a.primary || i === 0 ? 'primary' : ''}`} onClick={a.run}>
            {i === 0 && <kbd>E</kbd>}
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TeamStrip() {
  const team = useStore((s) => s.game!.team);
  const setModal = useStore((s) => s.setModal);
  return (
    <div className="team-strip">
      {team.map((p) => {
        const mhp = maxHp(p);
        return (
          <button key={p.uid} type="button" className={`ts-mon${p.hp <= 0 ? ' fainted' : ''}`} onClick={() => setModal('pokemon', p.uid)} title={displayName(p)}>
            <MonIcon species={p.species} shiny={p.shiny} size={40} />
            <span className="ts-info">
              <span className="ts-name">
                {displayName(p)} <small>ур. {p.level}</small>
              </span>
              <span className="ts-hp">
                <span style={{ width: `${(p.hp / mhp) * 100}%`, background: hpColor(p.hp / mhp) }} />
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function levelRange(locId: string): string | null {
  const wild = getLocation(locId).wild;
  if (!wild?.length) return null;
  return `ур. ${Math.min(...wild.map((w) => w.min))}–${Math.max(...wild.map((w) => w.max))}`;
}

export function OverworldView() {
  const game = useStore((s) => s.game)!;
  const settings = useStore((s) => s.settings);
  const setModal = useStore((s) => s.setModal);
  const toast = useStore((s) => s.toast);
  const prompt = useWorld((s) => s.prompt);
  const setPrompt = useWorld((s) => s.setPrompt);
  const [fade, setFade] = useState(false);
  const loc = getLocation(game.location);
  const touch = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches, []);
  const [hint, setHint] = useState(() => {
    try {
      return !localStorage.getItem('liga3d-hint');
    } catch {
      return true;
    }
  });

  const blocked = game.pendingEvolution.length > 0 || game.pendingLearn.length > 0;

  const handlers = useMemo<OverworldHandlers>(
    () => ({
      onEncounter: (s) => {
        if (useStore.getState().game!.pendingEvolution.length || useStore.getState().game!.pendingLearn.length) {
          runtime.lock = false;
          return;
        }
        markBattleSpot(s.x, s.z);
        setFade(true);
        setTimeout(() => {
          runtime.spawns.delete(s.id);
          useWorld.getState().syncSpawns();
          const r = useStore.getState().act((g) => encounterWild(g, s.species, s.level, s.shiny, defaultRng), { quiet: true });
          if (!r.ok) {
            toast(r.message, 'error');
            runtime.lock = false;
          }
          setFade(false);
        }, 420);
      },
      onGate: (to) => {
        const g = useStore.getState().game!;
        if (!canEnter(g, to)) {
          const need = getLocation(to).requiresBadge;
          toast(`Путь закрыт: нужен ${need ? BADGES[need].name : 'значок'}.`, 'error');
          const k = 0.82;
          runtime.player.x *= k;
          runtime.player.z *= k;
          runtime.lock = false;
          return;
        }
        setFade(true);
        setTimeout(() => {
          const r = useStore.getState().act((st) => travel(st, to), { quiet: true });
          if (!r.ok) {
            toast(r.message, 'error');
            runtime.lock = false;
          }
          setFade(false);
        }, 380);
      },
      onPickup: (p) => {
        const r = useStore.getState().act((g) => pickupItem(g, p.item), { quiet: true });
        toast(r.message, getItem(p.item).price >= 2000 ? 'rare' : 'ok');
      },
      trainerDone: (id) => useStore.getState().game!.defeatedTrainers.includes(id),
      promptAt: (x: number, z: number, layout: Layout): Prompt | null => {
        const g = useStore.getState().game!;
        for (const b of layout.buildings) {
          if (Math.hypot(x - b.door[0], z - b.door[1]) > 2.6) continue;
          if (b.kind === 'pokecenter') {
            return {
              key: 'pc',
              title: 'Покецентр',
              subtitle: 'Лечение и питомник',
              actions: [
                { label: 'Вылечить покемонов', run: () => useStore.getState().act(healAtCenter), primary: true },
                { label: 'Питомник', run: () => setModal('storage') },
              ],
            };
          }
          if (b.kind === 'shop') return { key: 'shop', title: 'Магазин', subtitle: 'Покеболы, лечение, камни', actions: [{ label: 'Войти', run: () => setModal('shop') }] };
          if (b.kind === 'gym' && layout.loc.gym) {
            const gym = layout.loc.gym;
            const done = g.defeatedTrainers.includes(gym.id);
            return {
              key: 'gym',
              title: `Стадион: ${gym.title} ${gym.name}`,
              subtitle: done ? 'Значок получен' : `Награда: ${gym.badge ? BADGES[gym.badge].name : gym.reward}`,
              actions: done ? [{ label: 'Стадион пройден', run: () => undefined }] : [{ label: 'Бросить вызов', run: () => startTrainer(gym.id) }],
            };
          }
          return { key: `house-${b.x}`, title: 'Жилой дом', subtitle: 'Здесь живут местные жители', actions: [{ label: 'Постучать', run: () => toast('Никого нет дома...') }] };
        }
        for (const t of layout.trainers) {
          if (Math.hypot(x - t.x, z - t.z) > 3) continue;
          const entry = trainersHere(g).find((e) => e.trainer.id === t.id);
          if (!entry) continue;
          const tr = entry.trainer;
          if (entry.defeated) return { key: `tr-${t.id}`, title: `${tr.title} ${tr.name}`, subtitle: 'Уже побеждён', actions: [{ label: 'Поговорить', run: () => toast(`${tr.title} ${tr.name}: «${tr.defeat}»`) }] };
          return {
            key: `tr-${t.id}`,
            title: `${tr.title} ${tr.name}`,
            subtitle: `«${tr.intro}»`,
            actions: [{ label: 'Сразиться', run: () => startTrainer(tr.id), primary: true }],
          };
        }
        if (layout.loc.fishing) {
          for (const l of layout.lakes) {
            const d = Math.hypot(x - l.x, z - l.z);
            if (d < l.r + 3.5 && d > l.r - 1) {
              const rod = bestRod(g);
              return {
                key: 'fish',
                title: 'Берег',
                subtitle: rod ? (rod === 2 ? 'Хорошая удочка' : 'Старая удочка') : 'Нужна удочка (магазин Камнеграда)',
                actions: [{ label: 'Рыбачить', run: () => doFish() }],
              };
            }
          }
        }
        return null;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const startTrainer = useCallback(
    (id: string) => {
      const spot = getLayout(runtime.loc).trainers.find((t) => t.id === id);
      markBattleSpot(spot?.x, spot?.z);
      setFade(true);
      setTimeout(() => {
        const r = useStore.getState().act((g) => challenge(g, id, defaultRng), { quiet: true });
        if (!r.ok) toast(r.message, 'error');
        setFade(false);
      }, 400);
    },
    [toast],
  );

  const doFish = useCallback(() => {
    markBattleSpot();
    const r = useStore.getState().act((g) => fish(g, defaultRng), { quiet: true });
    if (!r.battle) toast(r.message, r.ok ? 'ok' : 'error');
  }, [toast]);

  useEffect(() => {
    setPrompt(null);
  }, [game.location, setPrompt]);

  useEffect(() => {
    runtime.lock = blocked;
  }, [blocked]);

  const range = levelRange(loc.id);
  const lead = game.team.find((p) => p.hp > 0);

  return (
    <div className="overworld">
      <Overworld locId={loc.id} quality={settings.quality} handlers={handlers} />

      <div className="ow-banner">
        <span className="biome-chip">{BIOME_LABELS[loc.biome]}</span>
        <h2>{loc.name}</h2>
        <small>
          {range ?? 'Безопасная зона'}
          {loc.requiresBadge ? ` · ${BADGES[loc.requiresBadge].name}` : ''}
        </small>
      </div>

      <TeamStrip />

      {prompt && !blocked && <PromptCard prompt={prompt} />}

      {!lead && <div className="ow-warning">Все покемоны без сил — дойдите до покецентра.</div>}

      {hint && (
        <div className="ow-hint">
          <p>
            <b>{touch ? 'Джойстик' : 'WASD / стрелки'}</b> — идти{!touch && ', Shift — шагом'}, <b>{touch ? 'тап по земле' : 'клик по земле'}</b> — идти туда,{' '}
            <b>перетаскивание</b> — вращать камеру{!touch && ', колесо — приблизить'}, <b>E</b> — действие.
          </p>
          <p>Дикие покемоны бродят в высокой траве — подойдите вплотную, чтобы начать бой. Арки по краям ведут в соседние локации.</p>
          <button
            type="button"
            className="btn small primary"
            onClick={() => {
              setHint(false);
              try {
                localStorage.setItem('liga3d-hint', '1');
              } catch {
                /* ignore */
              }
            }}
          >
            Понятно
          </button>
        </div>
      )}

      {touch && <Joystick />}
      <div className={`fade${fade ? ' on' : ''}`} />
      <div className="ow-legend">
        {(loc.wild ?? []).slice(0, 8).map((w) => (
          <span key={w.species} title={game.dex[w.species] ? getSpecies(w.species).name : '???'}>
            <MonIcon species={w.species} size={26} silhouette={!game.dex[w.species]} />
          </span>
        ))}
      </div>
    </div>
  );
}
