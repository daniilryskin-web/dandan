import { BADGES } from '../data/world';
import { useStore } from '../state/store';
import { MonCard, Money } from './common';

export function TopBar() {
  const game = useStore((s) => s.game)!;
  const setModal = useStore((s) => s.setModal);
  const inBattle = !!game.battle;
  const caught = Object.values(game.dex).filter((v) => v === 'caught').length;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo-ball small" aria-hidden="true" />
        <strong>Лига 3D</strong>
      </div>
      <div className="trainer-info">
        <span className="trainer-name">🧢 {game.player.name}</span>
        <Money value={game.player.money} />
        <span className="badges" title="Значки">
          {Object.entries(BADGES).map(([id, b]) => (
            <span key={id} className={`badge-gem${game.player.badges.includes(id) ? ' got' : ''}`} style={{ ['--gem' as string]: b.color }} title={b.name} />
          ))}
        </span>
      </div>
      <nav className="topnav">
        <button className="btn ghost" type="button" onClick={() => setModal('bag')}>
          🎒 Сумка
        </button>
        <button className="btn ghost" type="button" onClick={() => setModal('dex')}>
          📕 Покедекс <small>{caught}</small>
        </button>
        <button className="btn ghost" type="button" disabled={inBattle} onClick={() => setModal('map')}>
          🗺 Карта
        </button>
        <button className="btn ghost" type="button" onClick={() => setModal('settings')}>
          ⚙
        </button>
      </nav>
    </header>
  );
}

export function Sidebar() {
  const game = useStore((s) => s.game)!;
  const setModal = useStore((s) => s.setModal);
  const activeUid = game.battle ? game.team[game.battle.playerActive]?.uid : null;
  return (
    <aside className="sidebar">
      <div className="panel">
        <div className="panel-head">
          <h3>Команда</h3>
          <span className="muted">{game.team.length}/6</span>
        </div>
        <div className="team-list">
          {game.team.map((p) => (
            <MonCard key={p.uid} p={p} active={p.uid === activeUid} onClick={() => setModal('pokemon', p.uid)} />
          ))}
        </div>
      </div>
      <div className="panel journal">
        <div className="panel-head">
          <h3>Дневник</h3>
        </div>
        <ul>
          {game.log.slice(0, 40).map((e) => (
            <li key={e.id} className={e.kind}>
              <time>{new Date(e.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>
              {e.text}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
