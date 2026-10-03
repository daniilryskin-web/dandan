import { useCallback, useEffect, useRef, useState } from 'react';
import { getItem } from '../data/items';
import { getMove, STATUS_INFO, type StatusId } from '../data/moves';
import { getSpecies } from '../data/species';
import { effectiveness, effectivenessLabel, TYPE_INFO } from '../data/types';
import { getLocation } from '../data/world';
import type { BattleEvent, Pokemon, Side } from '../engine/model';
import { displayName, maxHp } from '../engine/pokemon';
import { useStore } from '../state/store';
import { ballTimeline, BattleScene, type BallState, type FxState } from '../three/BattleScene';
import type { CreatureAnim } from '../three/CreatureModel';
import { ExpBar, GenderMark, HpBar, hpColor, MonIcon, StatusBadge, TypeBadge } from './common';

type Anim = { anim: CreatureAnim; key: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HP a pokemon had when it was sent out, reconstructed from the following events of the same turn. */
function hpAtSwitch(events: BattleEvent[], from: number, side: Side, current: number): number {
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e.t === 'switch' && e.side === side) break;
    if (e.t === 'damage' && e.side === side) return e.hp + e.amount;
    if (e.t === 'heal' && e.side === side) return e.hp - e.amount;
  }
  return current;
}

export function BattleView() {
  const game = useStore((s) => s.game)!;
  const battle = game.battle!;
  const settings = useStore((s) => s.settings);
  const doBattle = useStore((s) => s.battle);
  const doForceSwitch = useStore((s) => s.forceSwitch);
  const doClose = useStore((s) => s.closeBattle);

  const [shownPlayer, setShownPlayer] = useState(() => game.team[battle.playerActive].uid);
  const [shownEnemy, setShownEnemy] = useState(() => battle.enemyTeam[battle.enemyActive].uid);
  const [hp, setHp] = useState(() => ({ player: game.team[battle.playerActive].hp, enemy: battle.enemyTeam[battle.enemyActive].hp }));
  const [status, setStatus] = useState<Record<Side, StatusId | null>>(() => ({
    player: game.team[battle.playerActive].status,
    enemy: battle.enemyTeam[battle.enemyActive].status,
  }));
  const [anims, setAnims] = useState<Record<Side, Anim>>({ player: { anim: 'appear', key: 1 }, enemy: { anim: 'appear', key: 1 } });
  const [fx, setFx] = useState<FxState | null>(null);
  const [ball, setBall] = useState<BallState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<'main' | 'bag' | 'team' | 'revive'>('main');
  const played = useRef(battle.turn > 0 ? battle.seq : 0);
  const fast = useRef(false);
  const alive = useRef(true);
  const counter = useRef(10);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const wait = useCallback(
    (ms: number) => sleep(fast.current ? Math.min(ms, 120) : ms / settings.battleSpeed),
    [settings.battleSpeed],
  );
  const animate = (side: Side, anim: CreatureAnim) => setAnims((a) => ({ ...a, [side]: { anim, key: ++counter.current } }));
  const effect = (f: Omit<FxState, 'key'>) => setFx({ ...f, key: ++counter.current });

  const play = useCallback(
    async (events: BattleEvent[]) => {
      setBusy(true);
      fast.current = false;
      const st = useStore.getState().game!;
      const b = st.battle!;
      for (let i = 0; i < events.length; i++) {
        if (!alive.current) return;
        const ev = events[i];
        switch (ev.t) {
          case 'msg':
            setText(ev.text);
            await wait(Math.min(1700, 700 + ev.text.length * 14));
            break;
          case 'move': {
            const mv = getMove(ev.moveId);
            const color = TYPE_INFO[mv.type].color;
            const foe: Side = ev.side === 'player' ? 'enemy' : 'player';
            if (mv.category === 'status') {
              const selfTarget = !!(mv.effect.heal || mv.effect.rest || mv.effect.stats?.target === 'self');
              effect({ kind: 'aura', from: ev.side, target: selfTarget ? ev.side : foe, color });
            } else {
              animate(ev.side, 'attack');
              effect({ kind: mv.category === 'special' ? 'projectile' : 'burst', from: ev.side, target: foe, color });
            }
            await wait(420);
            break;
          }
          case 'damage':
            animate(ev.side, 'hit');
            setHp((h) => ({ ...h, [ev.side]: ev.hp }));
            await wait(ev.crit || ev.eff >= 2 ? 650 : 480);
            break;
          case 'heal':
            setHp((h) => ({ ...h, [ev.side]: ev.hp }));
            effect({ kind: 'aura', from: ev.side, target: ev.side, color: '#66e08a' });
            await wait(450);
            break;
          case 'status':
            setStatus((s) => ({ ...s, [ev.side]: ev.status }));
            if (ev.status) effect({ kind: 'aura', from: ev.side, target: ev.side, color: STATUS_INFO[ev.status].color });
            await wait(350);
            break;
          case 'stat':
            effect({ kind: 'aura', from: ev.side, target: ev.side, color: ev.delta > 0 ? '#5ec8ff' : '#ff6a6a' });
            await wait(300);
            break;
          case 'miss':
            await wait(200);
            break;
          case 'faint':
            animate(ev.side, 'faint');
            await wait(850);
            break;
          case 'switch': {
            if (ev.side === 'player') {
              const p = st.team.find((x) => x.uid === ev.uid)!;
              setShownPlayer(ev.uid);
              setHp((h) => ({ ...h, player: hpAtSwitch(events, i, 'player', p.hp) }));
              setStatus((s) => ({ ...s, player: p.status }));
            } else {
              const p = b.enemyTeam.find((x) => x.uid === ev.uid)!;
              setShownEnemy(ev.uid);
              setHp((h) => ({ ...h, enemy: hpAtSwitch(events, i, 'enemy', p.hp) }));
              setStatus((s) => ({ ...s, enemy: p.status }));
            }
            animate(ev.side, 'appear');
            await wait(500);
            break;
          }
          case 'ball': {
            const tl = ballTimeline(ev.shakes);
            setBall({ key: ++counter.current, color: getItem(ev.ball).icon, shakes: ev.shakes, caught: ev.caught });
            await sleep(tl.captureAt);
            animate('enemy', 'capture');
            await sleep(tl.resultAt - tl.captureAt);
            if (!ev.caught) {
              setBall(null);
              animate('enemy', 'appear');
            }
            await sleep(500);
            break;
          }
          case 'levelup':
            effect({ kind: 'aura', from: 'player', target: 'player', color: '#ffd54f' });
            break;
          default:
            break;
        }
      }
      if (alive.current) setBusy(false);
    },
    [wait],
  );

  useEffect(() => {
    if (battle.seq !== played.current) {
      played.current = battle.seq;
      setMenu('main');
      play(battle.lastEvents);
    } else if (!text && battle.lastEvents.length) {
      const lastMsg = [...battle.lastEvents].reverse().find((e) => e.t === 'msg');
      if (lastMsg && lastMsg.t === 'msg') setText(lastMsg.text);
    }
  }, [battle.seq, battle.lastEvents, play, text]);

  const player = game.team.find((p) => p.uid === shownPlayer) ?? game.team[battle.playerActive];
  const enemy = battle.enemyTeam.find((p) => p.uid === shownEnemy) ?? battle.enemyTeam[battle.enemyActive];
  const enemySp = getSpecies(enemy.species);
  const loc = getLocation(game.location);
  const canAct = !busy && battle.phase === 'choose';

  return (
    <div className="battle-view">
      <BattleScene
        biome={battle.biome}
        seedKey={loc.id}
        player={{ species: player.species, shiny: player.shiny, anim: anims.player.anim, animKey: anims.player.key }}
        enemy={{ species: enemy.species, shiny: enemy.shiny, anim: anims.enemy.anim, animKey: anims.enemy.key }}
        fx={fx}
        ball={ball}
        useSprites={settings.useSprites}
      />

      <div className="hud hud-enemy">
        <div className="hud-line">
          <span className="hud-name">
            {enemy.shiny && <span className="shiny-star">✦</span>}
            {displayName(enemy)}
            <GenderMark gender={enemy.gender} />
            {game.dex[enemy.species] === 'caught' && battle.kind === 'wild' && <span className="caught-dot" title="Уже пойман" />}
          </span>
          <span className="hud-level">ур. {enemy.level}</span>
        </div>
        <div className="hud-types">
          {enemySp.types.map((t) => (
            <TypeBadge key={t} type={t} small />
          ))}
          <StatusBadge status={status.enemy} />
        </div>
        <HpBar hp={hp.enemy} max={maxHp(enemy)} showNumbers={false} />
        {battle.kind === 'trainer' && (
          <div className="trainer-balls" title="Покемоны соперника">
            <small>{battle.trainerName}</small>
            {battle.enemyTeam.map((p) => (
              <span key={p.uid} className={`mini-ball${p.hp <= 0 ? ' out' : ''}`} />
            ))}
          </div>
        )}
      </div>

      <div className="hud hud-player">
        <div className="hud-line">
          <span className="hud-name">
            {player.shiny && <span className="shiny-star">✦</span>}
            {displayName(player)}
            <GenderMark gender={player.gender} />
          </span>
          <span className="hud-level">ур. {player.level}</span>
        </div>
        <div className="hud-types">
          {getSpecies(player.species).types.map((t) => (
            <TypeBadge key={t} type={t} small />
          ))}
          <StatusBadge status={status.player} />
        </div>
        <HpBar hp={hp.player} max={maxHp(player)} />
        <ExpBar p={player} />
      </div>

      <div className="battle-bottom">
        <button className="battle-text" type="button" onClick={() => (fast.current = true)} title="Нажмите, чтобы ускорить">
          {text}
          {busy && <span className="text-caret">▼</span>}
        </button>

        {canAct && menu === 'main' && <MainMenu player={player} enemy={enemy} onMove={(i) => doBattle({ kind: 'move', index: i })} setMenu={setMenu} wild={battle.kind === 'wild'} onRun={() => doBattle({ kind: 'run' })} />}
        {canAct && menu === 'bag' && <BagMenu wild={battle.kind === 'wild'} onBack={() => setMenu('main')} onUse={(id) => {
          if (getItem(id).kind === 'revive') setMenu('revive');
          else doBattle({ kind: 'item', itemId: id });
        }} />}
        {canAct && menu === 'revive' && (
          <TeamPicker
            title="Кого оживить?"
            filter={(p) => p.hp <= 0}
            onPick={(p) => doBattle({ kind: 'item', itemId: 'revive', targetUid: p.uid })}
            onBack={() => setMenu('bag')}
          />
        )}
        {canAct && menu === 'team' && (
          <TeamPicker
            title="Кого выпустить?"
            filter={(p) => p.hp > 0 && p.uid !== game.team[battle.playerActive].uid}
            onPick={(p) => doBattle({ kind: 'switch', index: game.team.findIndex((x) => x.uid === p.uid) })}
            onBack={() => setMenu('main')}
          />
        )}
        {!busy && battle.phase === 'forceSwitch' && (
          <TeamPicker title="Ваш покемон без сил. Кого выпустить?" filter={(p) => p.hp > 0} onPick={(p) => doForceSwitch(game.team.findIndex((x) => x.uid === p.uid))} />
        )}
      </div>

      {!busy && battle.phase === 'ended' && (
        <div className={`battle-result ${battle.result}`}>
          <div className="result-card">
            <h2>
              {battle.result === 'win' && 'Победа!'}
              {battle.result === 'caught' && 'Покемон пойман!'}
              {battle.result === 'fled' && 'Бой окончен'}
              {battle.result === 'lose' && 'Поражение'}
            </h2>
            {battle.result === 'caught' && (
              <div className="result-mon">
                <MonIcon species={enemy.species} shiny={enemy.shiny} size={72} />
                <div>
                  <strong>{displayName(enemy)}</strong> · ур. {enemy.level}
                  <div className="muted">{enemySp.types.map((t) => TYPE_INFO[t].name).join(' / ')}</div>
                </div>
              </div>
            )}
            {battle.result === 'lose' && <p className="muted">Вы очнётесь в последнем посещённом покецентре.</p>}
            <button className="btn primary big" type="button" autoFocus onClick={doClose}>
              Продолжить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MainMenu({ player, enemy, onMove, setMenu, wild, onRun }: {
  player: Pokemon; enemy: Pokemon; onMove: (i: number) => void; setMenu: (m: 'bag' | 'team') => void; wild: boolean; onRun: () => void;
}) {
  const enemyTypes = getSpecies(enemy.species).types;
  const playerTypes = getSpecies(player.species).types;
  const allEmpty = player.moves.every((m) => m.pp <= 0);
  return (
    <div className="battle-menu">
      <div className="moves">
        {player.moves.map((slot, i) => {
          const mv = getMove(slot.id);
          const eff = mv.category === 'status' ? 1 : effectiveness(mv.type, enemyTypes);
          const label = mv.category === 'status' ? null : effectivenessLabel(eff);
          const stab = mv.category !== 'status' && playerTypes.includes(mv.type);
          return (
            <button
              key={slot.id}
              type="button"
              className={`move-btn${eff >= 2 ? ' strong' : ''}${eff === 0 ? ' useless' : ''}`}
              style={{ ['--type' as string]: TYPE_INFO[mv.type].color }}
              disabled={slot.pp <= 0 && !allEmpty}
              onClick={() => onMove(i)}
              title={`${TYPE_INFO[mv.type].name} · ${mv.category === 'physical' ? 'физическая' : mv.category === 'special' ? 'специальная' : 'статусная'}${mv.power ? ` · сила ${mv.power}` : ''}${mv.accuracy ? ` · точность ${mv.accuracy}%` : ''}`}
            >
              <span className="move-name">{mv.name}</span>
              <span className="move-meta">
                <span className="move-type">{TYPE_INFO[mv.type].name}</span>
                {mv.power > 0 && <span>сила {mv.power}{stab ? '★' : ''}</span>}
                <span className="pp" style={{ color: slot.pp === 0 ? 'var(--hp-low)' : undefined }}>
                  PP {slot.pp}/{slot.maxPp}
                </span>
              </span>
              {label && <span className="eff-label">{label}</span>}
            </button>
          );
        })}
      </div>
      <div className="side-actions">
        <button className="btn" type="button" onClick={() => setMenu('bag')}>
          🎒 Сумка
        </button>
        <button className="btn" type="button" onClick={() => setMenu('team')}>
          ⇄ Покемоны
        </button>
        <button className="btn ghost" type="button" disabled={!wild} onClick={onRun} title={wild ? '' : 'Из боя с тренером не сбежать'}>
          🏃 Бежать
        </button>
      </div>
    </div>
  );
}

function BagMenu({ wild, onBack, onUse }: { wild: boolean; onBack: () => void; onUse: (id: string) => void }) {
  const bag = useStore((s) => s.game!.bag);
  const items = Object.entries(bag)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ item: getItem(id), n }))
    .filter(({ item }) => (item.kind === 'ball' ? wild : ['heal', 'status', 'revive', 'pp'].includes(item.kind)));
  return (
    <div className="battle-menu column">
      <div className="submenu-head">
        <button className="btn small ghost" type="button" onClick={onBack}>
          ← Назад
        </button>
        <span className="muted">Предмет тратит ход</span>
      </div>
      <div className="item-grid">
        {items.length === 0 && <p className="muted">Подходящих предметов нет.</p>}
        {items.map(({ item, n }) => (
          <button key={item.id} type="button" className="item-btn" onClick={() => onUse(item.id)} title={item.desc}>
            <span className="item-dot" style={{ background: item.icon }} />
            <span>{item.name}</span>
            <span className="count">×{n}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TeamPicker({ title, filter, onPick, onBack }: { title: string; filter: (p: Pokemon) => boolean; onPick: (p: Pokemon) => void; onBack?: () => void }) {
  const team = useStore((s) => s.game!.team);
  return (
    <div className="battle-menu column">
      <div className="submenu-head">
        {onBack && (
          <button className="btn small ghost" type="button" onClick={onBack}>
            ← Назад
          </button>
        )}
        <span>{title}</span>
      </div>
      <div className="team-pick">
        {team.map((p) => {
          const ok = filter(p);
          const mhp = maxHp(p);
          return (
            <button key={p.uid} type="button" className="team-pick-btn" disabled={!ok} onClick={() => onPick(p)}>
              <MonIcon species={p.species} shiny={p.shiny} size={36} />
              <span className="tp-name">
                {displayName(p)} <small>ур. {p.level}</small>
              </span>
              <span className="tp-hp" style={{ color: hpColor(p.hp / mhp) }}>
                {p.hp}/{mhp}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
