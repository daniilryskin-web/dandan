import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getItem } from '../data/items';
import { getMove, STATUS_INFO, type StatusId } from '../data/moves';
import { getSpecies } from '../data/species';
import { effectiveness, effectivenessLabel, TYPE_INFO, type PokeType } from '../data/types';
import type { BattleEvent, Pokemon, Side } from '../engine/model';
import { displayName, maxHp } from '../engine/pokemon';
import { useStore } from '../state/store';
import {
  ballTimeline, BattleWorld, makeArena, type BallState, type CameraFocus, type MoveFxState, type Popup,
} from '../three/BattleWorld';
import type { CreatureAnim } from '../three/CreatureModel';
import { ExpBar, GenderMark, hpColor, ItemIcon, MonIcon, StatusBadge } from './common';
import { playCry, sfx } from './sound';
import { TypeGlyph, TypePill } from './TypeIcon';

type Anim = { anim: CreatureAnim; key: number };
type Menu = 'main' | 'fight' | 'bag' | 'team' | 'revive';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const other = (s: Side): Side => (s === 'player' ? 'enemy' : 'player');

const STATUS_FX: Record<StatusId, PokeType> = { brn: 'fire', psn: 'poison', par: 'electric', slp: 'psychic', frz: 'ice' };

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

  const arena = useMemo(() => makeArena(game.location), [game.location]);
  const intro = useRef(battle.turn === 0);

  const [shownPlayer, setShownPlayer] = useState(() => game.team[battle.playerActive].uid);
  const [shownEnemy, setShownEnemy] = useState(() => battle.enemyTeam[battle.enemyActive].uid);
  const shownRef = useRef({ player: shownPlayer, enemy: shownEnemy });
  shownRef.current = { player: shownPlayer, enemy: shownEnemy };
  const [hp, setHp] = useState(() => ({ player: game.team[battle.playerActive].hp, enemy: battle.enemyTeam[battle.enemyActive].hp }));
  const [status, setStatus] = useState<Record<Side, StatusId | null>>(() => ({
    player: game.team[battle.playerActive].status,
    enemy: battle.enemyTeam[battle.enemyActive].status,
  }));
  const [anims, setAnims] = useState<Record<Side, Anim>>(() => ({
    player: { anim: intro.current ? 'hidden' : 'appear', key: 1 },
    enemy: { anim: 'appear', key: 1 },
  }));
  const [fx, setFx] = useState<MoveFxState | null>(null);
  const [ball, setBall] = useState<BallState | null>(null);
  const [popups, setPopups] = useState<Popup[]>([]);
  const [focus, setFocus] = useState<CameraFocus>(intro.current ? 'intro' : 'idle');
  const [shake, setShake] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<Menu>('main');
  const played = useRef(battle.turn > 0 ? battle.seq : 0);
  const fast = useRef(false);
  const alive = useRef(true);
  const counter = useRef(10);

  useEffect(() => {
    alive.current = true;
    if (intro.current) playCry(battle.enemyTeam[battle.enemyActive].species);
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wait = useCallback(
    (ms: number) => sleep(fast.current ? Math.min(ms, 120) : ms / settings.battleSpeed),
    [settings.battleSpeed],
  );
  const animate = (side: Side, anim: CreatureAnim) => setAnims((a) => ({ ...a, [side]: { anim, key: ++counter.current } }));
  const effect = (f: Omit<MoveFxState, 'key'>) => setFx({ ...f, key: ++counter.current });
  const pop = (side: Side, txt: string, tone: Popup['tone']) => {
    const key = ++counter.current;
    setPopups((p) => [...p.slice(-5), { key, side, text: txt, tone }]);
    setTimeout(() => alive.current && setPopups((p) => p.filter((x) => x.key !== key)), 1500);
  };

  const play = useCallback(
    async (events: BattleEvent[]) => {
      setBusy(true);
      fast.current = false;
      const st = useStore.getState().game!;
      const b = st.battle!;
      const speciesOf = (side: Side) =>
        side === 'player'
          ? st.team.find((x) => x.uid === shownRef.current.player)?.species
          : b.enemyTeam.find((x) => x.uid === shownRef.current.enemy)?.species;
      for (let i = 0; i < events.length; i++) {
        if (!alive.current) return;
        const ev = events[i];
        switch (ev.t) {
          case 'msg':
            if (intro.current && ev.text.startsWith('Вперёд')) {
              intro.current = false;
              setFocus('idle');
              animate('player', 'appear');
              const sp = speciesOf('player');
              if (sp) playCry(sp);
            }
            setText(ev.text);
            await wait(Math.min(1700, 700 + ev.text.length * 14));
            break;
          case 'move': {
            const mv = getMove(ev.moveId);
            const foe = other(ev.side);
            const selfTarget = mv.category === 'status' && !!(mv.effect.heal || mv.effect.rest || mv.effect.protect || mv.effect.stats?.target === 'self');
            setFocus(ev.side === 'player' ? 'enemy' : 'player');
            if (mv.category !== 'status') animate(ev.side, 'attack');
            effect({
              type: mv.type,
              kind: mv.category === 'status' ? 'status' : mv.category === 'special' ? 'projectile' : 'contact',
              from: ev.side,
              target: selfTarget ? ev.side : foe,
            });
            await wait(mv.category === 'special' ? 560 : 440);
            break;
          }
          case 'damage': {
            animate(ev.side, 'hit');
            setHp((h) => ({ ...h, [ev.side]: ev.hp }));
            const tone: Popup['tone'] = ev.crit ? 'crit' : ev.eff >= 2 ? 'super' : ev.eff < 1 ? 'weak' : 'damage';
            pop(ev.side, `−${ev.amount}`, tone);
            sfx(tone === 'damage' ? 'hit' : tone);
            if (ev.crit || ev.eff >= 2) setShake((s) => s + 1);
            await wait(ev.crit || ev.eff >= 2 ? 700 : 520);
            break;
          }
          case 'heal':
            setHp((h) => ({ ...h, [ev.side]: ev.hp }));
            pop(ev.side, `+${ev.amount}`, 'heal');
            effect({ type: 'fairy', kind: 'status', from: ev.side, target: ev.side });
            sfx('heal');
            await wait(500);
            break;
          case 'status':
            setStatus((s) => ({ ...s, [ev.side]: ev.status }));
            if (ev.status) {
              effect({ type: STATUS_FX[ev.status], kind: 'status', from: ev.side, target: ev.side });
              pop(ev.side, STATUS_INFO[ev.status].name, 'info');
              sfx('down');
            }
            await wait(400);
            break;
          case 'confuse':
            effect({ type: 'psychic', kind: 'status', from: ev.side, target: ev.side });
            pop(ev.side, 'Замешательство', 'info');
            await wait(380);
            break;
          case 'protect':
            effect({ type: 'steel', kind: 'status', from: ev.side, target: ev.side });
            await wait(320);
            break;
          case 'stat':
            effect({ type: ev.delta > 0 ? 'ice' : 'dark', kind: 'status', from: ev.side, target: ev.side });
            pop(ev.side, ev.delta > 0 ? '▲'.repeat(Math.min(3, ev.delta)) : '▼'.repeat(Math.min(3, -ev.delta)), ev.delta > 0 ? 'heal' : 'weak');
            sfx(ev.delta > 0 ? 'up' : 'down');
            await wait(340);
            break;
          case 'miss':
            pop(other(ev.side), 'Мимо!', 'info');
            await wait(240);
            break;
          case 'faint': {
            animate(ev.side, 'faint');
            const sp = speciesOf(ev.side);
            if (sp) playCry(sp, { rate: 0.75 });
            sfx('faint');
            await wait(900);
            break;
          }
          case 'switch': {
            if (ev.side === 'player') {
              const p = st.team.find((x) => x.uid === ev.uid)!;
              shownRef.current.player = ev.uid;
              setShownPlayer(ev.uid);
              setHp((h) => ({ ...h, player: hpAtSwitch(events, i, 'player', p.hp) }));
              setStatus((s) => ({ ...s, player: p.status }));
              playCry(p.species);
            } else {
              const p = b.enemyTeam.find((x) => x.uid === ev.uid)!;
              shownRef.current.enemy = ev.uid;
              setShownEnemy(ev.uid);
              setHp((h) => ({ ...h, enemy: hpAtSwitch(events, i, 'enemy', p.hp) }));
              setStatus((s) => ({ ...s, enemy: p.status }));
              playCry(p.species);
            }
            intro.current = false;
            animate(ev.side, 'appear');
            await wait(560);
            break;
          }
          case 'ball': {
            const tl = ballTimeline(ev.shakes);
            setFocus('enemy');
            sfx('throw');
            setBall({ key: ++counter.current, color: getItem(ev.ball).icon, shakes: ev.shakes, caught: ev.caught });
            await sleep(tl.captureAt);
            animate('enemy', 'capture');
            for (let s = 0; s < ev.shakes; s++) setTimeout(() => alive.current && sfx('shake'), tl.landAt - tl.captureAt + s * 650 + 60);
            await sleep(tl.resultAt - tl.captureAt);
            if (ev.caught) {
              sfx('caught');
            } else {
              setBall(null);
              animate('enemy', 'appear');
              sfx('escape');
              const sp = speciesOf('enemy');
              if (sp) playCry(sp);
            }
            await sleep(600);
            break;
          }
          case 'exp':
            if (ev.uid === shownRef.current.player) pop('player', `+${ev.amount} опыта`, 'info');
            break;
          case 'levelup':
            if (ev.uid === shownRef.current.player) {
              effect({ type: 'electric', kind: 'status', from: 'player', target: 'player' });
              pop('player', `Ур. ${ev.level}!`, 'heal');
            }
            sfx('level');
            await wait(500);
            break;
          default:
            break;
        }
      }
      if (!alive.current) return;
      intro.current = false;
      setFocus('idle');
      setBusy(false);
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
  const canAct = !busy && battle.phase === 'choose';
  const wild = battle.kind === 'wild';

  const go = (m: Menu) => {
    sfx(m === 'main' ? 'back' : 'select');
    setMenu(m);
  };

  // Keyboard: 1–4 pick moves, Esc goes back, Space/Enter skips text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (busy && (e.key === ' ' || e.key === 'Enter')) {
        fast.current = true;
        return;
      }
      if (!canAct) return;
      if (e.key === 'Escape' && menu !== 'main') {
        e.preventDefault();
        go(menu === 'revive' ? 'bag' : 'main');
      } else if (menu === 'main' && (e.key === 'f' || e.key === 'а')) go('fight');
      else if (menu === 'fight' && /^[1-4]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (player.moves[i]) doBattle({ kind: 'move', index: i });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const prompt = canAct ? `Что сделает ${displayName(game.team[battle.playerActive])}?` : text;

  return (
    <div className="battle-view sv">
      <BattleWorld
        locId={game.location}
        arena={arena}
        quality={settings.quality}
        player={{ species: player.species, shiny: player.shiny, anim: anims.player.anim, animKey: anims.player.key }}
        enemy={{ species: enemy.species, shiny: enemy.shiny, anim: anims.enemy.anim, animKey: anims.enemy.key }}
        trainerBattle={battle.kind === 'trainer'}
        fx={fx}
        ball={ball}
        popups={popups}
        focus={focus}
        shake={shake}
      />

      <InfoPlate
        side="enemy"
        p={enemy}
        hp={hp.enemy}
        status={status.enemy}
        caught={wild && game.dex[enemy.species] === 'caught'}
        extra={
          battle.kind === 'trainer' ? (
            <div className="sv-team-balls" title={battle.trainerName}>
              {battle.enemyTeam.map((p) => (
                <span key={p.uid} className={`mini-ball${p.hp <= 0 ? ' out' : ''}`} />
              ))}
            </div>
          ) : null
        }
        hidden={false}
      />
      <InfoPlate side="player" p={player} hp={hp.player} status={status.player} hidden={anims.player.anim === 'hidden'} />

      <button className={`sv-message${prompt ? '' : ' empty'}`} type="button" onClick={() => (fast.current = true)} title="Нажмите, чтобы ускорить">
        <span>{prompt}</span>
        {busy && <span className="text-caret">▼</span>}
      </button>

      <div className="sv-commands">
        {canAct && menu === 'main' && (
          <div className="sv-main">
            <button type="button" className="sv-cmd fight" onClick={() => go('fight')}>
              <span className="sv-cmd-icon">⚔</span>Бой
            </button>
            <button type="button" className="sv-cmd mons" onClick={() => go('team')}>
              <span className="sv-cmd-icon">◓</span>Покемоны
            </button>
            <button type="button" className="sv-cmd bag" onClick={() => go('bag')}>
              <span className="sv-cmd-icon">▣</span>Сумка
            </button>
            <button
              type="button"
              className="sv-cmd run"
              disabled={!wild}
              onClick={() => {
                sfx('escape');
                doBattle({ kind: 'run' });
              }}
              title={wild ? '' : 'Из боя с тренером не сбежать'}
            >
              <span className="sv-cmd-icon">➜</span>Бежать
            </button>
          </div>
        )}
        {canAct && menu === 'fight' && (
          <MoveList
            player={player}
            enemy={enemy}
            knownEnemy={!!game.dex[enemy.species]}
            onMove={(i) => {
              sfx('select');
              doBattle({ kind: 'move', index: i });
            }}
            onBack={() => go('main')}
          />
        )}
        {canAct && menu === 'bag' && (
          <BagMenu
            wild={wild}
            onBack={() => go('main')}
            onUse={(id) => {
              sfx('select');
              if (getItem(id).kind === 'revive') setMenu('revive');
              else doBattle({ kind: 'item', itemId: id });
            }}
          />
        )}
        {canAct && menu === 'revive' && (
          <TeamPicker
            title="Кого оживить?"
            filter={(p) => p.hp <= 0}
            onPick={(p) => doBattle({ kind: 'item', itemId: 'revive', targetUid: p.uid })}
            onBack={() => go('bag')}
          />
        )}
        {canAct && menu === 'team' && (
          <TeamPicker
            title="Кого выпустить?"
            filter={(p) => p.hp > 0 && p.uid !== game.team[battle.playerActive].uid}
            onPick={(p) => doBattle({ kind: 'switch', index: game.team.findIndex((x) => x.uid === p.uid) })}
            onBack={() => go('main')}
          />
        )}
        {!busy && battle.phase === 'forceSwitch' && (
          <TeamPicker title="Ваш покемон без сил. Кого выпустить?" filter={(p) => p.hp > 0} onPick={(p) => doForceSwitch(game.team.findIndex((x) => x.uid === p.uid))} />
        )}
      </div>

      {!busy && battle.phase === 'ended' && (
        <div className={`battle-result ${battle.result}`}>
          <div className="result-card sv-result">
            <div className="sv-result-ribbon">
              {battle.result === 'win' && 'Победа!'}
              {battle.result === 'caught' && 'Покемон пойман!'}
              {battle.result === 'fled' && 'Бой окончен'}
              {battle.result === 'lose' && 'Поражение'}
            </div>
            {battle.result === 'caught' && (
              <div className="result-mon">
                <MonIcon species={enemy.species} shiny={enemy.shiny} size={96} />
                <div>
                  <strong>{displayName(enemy)}</strong> · ур. {enemy.level}
                  <div className="sv-types">
                    {enemySp.types.map((t) => (
                      <TypePill key={t} type={t} />
                    ))}
                  </div>
                </div>
              </div>
            )}
            {battle.result === 'win' && battle.kind === 'trainer' && <p className="muted">{battle.trainerName} повержен.</p>}
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

function InfoPlate({ side, p, hp, status, caught, extra, hidden }: {
  side: Side; p: Pokemon; hp: number; status: StatusId | null; caught?: boolean; extra?: ReactNode; hidden?: boolean;
}) {
  const max = maxHp(p);
  const ratio = Math.max(0, Math.min(1, hp / max));
  const sp = getSpecies(p.species);
  return (
    <div className={`sv-plate ${side}${hidden ? ' hidden' : ''}`}>
      <div className="sv-plate-top">
        <span className="sv-name">
          {p.shiny && <span className="shiny-star">✦</span>}
          {displayName(p)}
          <GenderMark gender={p.gender} />
          {caught && <span className="caught-dot" title="Уже пойман" />}
        </span>
        <span className="sv-level">
          <small>Ур.</small>
          {p.level}
        </span>
      </div>
      <div className="sv-hp">
        <span className="sv-hp-label">HP</span>
        <div className="sv-hp-track">
          <div className="sv-hp-trail" style={{ width: `${ratio * 100}%` }} />
          <div className="sv-hp-fill" style={{ width: `${ratio * 100}%`, background: hpColor(ratio) }} />
        </div>
      </div>
      <div className="sv-plate-bottom">
        <span className="sv-types">
          {sp.types.map((t) => (
            <TypePill key={t} type={t} compact />
          ))}
          <StatusBadge status={status} />
        </span>
        {side === 'player' ? (
          <span className="sv-hp-num">
            {Math.max(0, hp)}
            <small>/{max}</small>
          </span>
        ) : (
          extra
        )}
      </div>
      {side === 'player' && <ExpBar p={p} />}
    </div>
  );
}

function MoveList({ player, enemy, knownEnemy, onMove, onBack }: {
  player: Pokemon; enemy: Pokemon; knownEnemy: boolean; onMove: (i: number) => void; onBack: () => void;
}) {
  const enemyTypes = getSpecies(enemy.species).types;
  const playerTypes = getSpecies(player.species).types;
  const allEmpty = player.moves.every((m) => m.pp <= 0);
  return (
    <div className="sv-moves">
      {player.moves.map((slot, i) => {
        const mv = getMove(slot.id);
        const eff = mv.category === 'status' ? 1 : effectiveness(mv.type, enemyTypes);
        const label = mv.category === 'status' || !knownEnemy ? null : effectivenessLabel(eff);
        const stab = mv.category !== 'status' && playerTypes.includes(mv.type);
        return (
          <button
            key={slot.id}
            type="button"
            className={`sv-move${eff >= 2 && knownEnemy ? ' strong' : ''}${eff === 0 && knownEnemy ? ' useless' : ''}`}
            style={{ ['--type' as string]: TYPE_INFO[mv.type].color }}
            disabled={slot.pp <= 0 && !allEmpty}
            onClick={() => onMove(i)}
            title={`${TYPE_INFO[mv.type].name} · ${mv.category === 'physical' ? 'физическая' : mv.category === 'special' ? 'специальная' : 'статусная'}${mv.power ? ` · сила ${mv.power}` : ''}${mv.accuracy ? ` · точность ${mv.accuracy}%` : ''}`}
          >
            <span className="sv-move-type">
              <TypeGlyph type={mv.type} size={20} />
            </span>
            <span className="sv-move-body">
              <span className="sv-move-name">{mv.name}</span>
              <span className="sv-move-meta">
                {mv.category === 'physical' ? 'Физ.' : mv.category === 'special' ? 'Спец.' : 'Статус'}
                {mv.power > 0 && ` · ${mv.power}${stab ? '★' : ''}`}
                {label && <em> · {label}</em>}
              </span>
            </span>
            <span className={`sv-move-pp${slot.pp === 0 ? ' empty' : slot.pp <= slot.maxPp / 4 ? ' low' : ''}`}>
              {slot.pp}
              <small>/{slot.maxPp}</small>
            </span>
            <kbd className="sv-key">{i + 1}</kbd>
          </button>
        );
      })}
      <button type="button" className="sv-back" onClick={onBack}>
        ← Назад <kbd>Esc</kbd>
      </button>
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
    <div className="sv-panel">
      <div className="sv-panel-head">
        <button type="button" className="sv-back" onClick={onBack}>
          ← Назад
        </button>
        <span>Сумка · предмет тратит ход</span>
      </div>
      <div className="sv-item-grid">
        {items.length === 0 && <p className="muted">Подходящих предметов нет.</p>}
        {items.map(({ item, n }) => (
          <button key={item.id} type="button" className="sv-item" onClick={() => onUse(item.id)} title={item.desc}>
            <ItemIcon id={item.id} color={item.icon} size={30} />
            <span className="sv-item-name">{item.name}</span>
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
    <div className="sv-panel">
      <div className="sv-panel-head">
        {onBack && (
          <button type="button" className="sv-back" onClick={onBack}>
            ← Назад
          </button>
        )}
        <span>{title}</span>
      </div>
      <div className="sv-team">
        {team.map((p) => {
          const ok = filter(p);
          const mhp = maxHp(p);
          const r = Math.max(0, p.hp / mhp);
          return (
            <button key={p.uid} type="button" className="sv-team-btn" disabled={!ok} onClick={() => onPick(p)}>
              <MonIcon species={p.species} shiny={p.shiny} size={44} />
              <span className="sv-team-info">
                <span className="sv-team-name">
                  {displayName(p)} <small>ур. {p.level}</small>
                </span>
                <span className="sv-team-hp">
                  <span style={{ width: `${r * 100}%`, background: hpColor(r) }} />
                </span>
                <small>
                  {p.hp}/{mhp}
                  {p.status && ` · ${STATUS_INFO[p.status].short}`}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
