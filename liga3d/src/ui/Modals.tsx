import { useEffect, useMemo, useRef, useState } from 'react';
import { getItem, KIND_LABELS, type ItemKind } from '../data/items';
import { DEX_INFO } from '../data/dexinfo';
import { getMove } from '../data/moves';
import { dexNo, getSpecies, SPECIES_LIST, STAT_KEYS, STAT_LABELS } from '../data/species';
import { TYPE_INFO } from '../data/types';
import { BADGES, BIOME_LABELS, getLocation, LOCATION_LIST } from '../data/world';
import { buy, canEnter, resolveEvolution, resolveLearn, sell, sellPrice, travel, withdraw } from '../engine/actions';
import { displayName } from '../engine/pokemon';
import { useStore } from '../state/store';
import { useSpriteManifest } from '../three/sprites';
import { MonCard, MonIcon, Modal, Money, TypeBadge } from './common';
import { MonPreview } from './PokemonModal';

const KIND_ORDER: ItemKind[] = ['ball', 'heal', 'status', 'revive', 'pp', 'stone', 'rod', 'key'];

export function BagModal() {
  const game = useStore((s) => s.game)!;
  const setModal = useStore((s) => s.setModal);
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: Object.entries(game.bag)
      .filter(([id, n]) => n > 0 && getItem(id).kind === kind)
      .map(([id, n]) => ({ item: getItem(id), n })),
  })).filter((g) => g.items.length);
  return (
    <Modal title="🎒 Сумка" onClose={() => setModal(null)}>
      {groups.length === 0 && <p className="muted">Сумка пуста.</p>}
      {groups.map((g) => (
        <div key={g.kind} className="bag-group">
          <h4>{KIND_LABELS[g.kind]}</h4>
          {g.items.map(({ item, n }) => (
            <div key={item.id} className="bag-row">
              <span className="item-dot" style={{ background: item.icon }} />
              <span className="bag-name">{item.name}</span>
              <span className="muted bag-desc">{item.desc}</span>
              <span className="count">×{n}</span>
            </div>
          ))}
        </div>
      ))}
      <p className="muted hint">Лечебные предметы и камни эволюции применяются из карточки покемона (нажмите на него в списке команды).</p>
    </Modal>
  );
}

export function ShopModal() {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const setModal = useStore((s) => s.setModal);
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState<Record<string, number>>({});
  const loc = getLocation(game.location);
  const stock = (loc.shop ?? []).map(getItem);
  const sellable = Object.entries(game.bag)
    .filter(([id, n]) => n > 0 && getItem(id).kind !== 'rod' && sellPrice(id) > 0)
    .map(([id, n]) => ({ item: getItem(id), n }));
  const q = (id: string) => qty[id] ?? 1;
  return (
    <Modal title={<>🛒 Магазин — {loc.name}</>} onClose={() => setModal(null)}>
      <div className="tabs">
        <button type="button" className={tab === 'buy' ? 'active' : ''} onClick={() => setTab('buy')}>
          Купить
        </button>
        <button type="button" className={tab === 'sell' ? 'active' : ''} onClick={() => setTab('sell')}>
          Продать
        </button>
        <span className="spacer" />
        <Money value={game.player.money} />
      </div>
      <div className="shop-list">
        {tab === 'buy' &&
          stock.map((it) => {
            const owned = game.bag[it.id] ?? 0;
            const isRod = it.kind === 'rod';
            return (
              <div key={it.id} className="shop-row">
                <span className="item-dot" style={{ background: it.icon }} />
                <div className="shop-info">
                  <strong>{it.name}</strong>
                  <small className="muted">
                    {it.desc} {owned > 0 && `· в сумке: ${owned}`}
                  </small>
                </div>
                <span className="price">{it.price}</span>
                {!isRod && (
                  <input
                    className="qty"
                    type="number"
                    min={1}
                    max={99}
                    value={q(it.id)}
                    onChange={(e) => setQty({ ...qty, [it.id]: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
                  />
                )}
                <button
                  className="btn small primary"
                  type="button"
                  disabled={(isRod && owned > 0) || it.price * (isRod ? 1 : q(it.id)) > game.player.money}
                  onClick={() => act((g) => buy(g, it.id, isRod ? 1 : q(it.id)))}
                >
                  {isRod && owned > 0 ? 'Есть' : 'Купить'}
                </button>
              </div>
            );
          })}
        {tab === 'sell' && sellable.length === 0 && <p className="muted">Нечего продать.</p>}
        {tab === 'sell' &&
          sellable.map(({ item, n }) => (
            <div key={item.id} className="shop-row">
              <span className="item-dot" style={{ background: item.icon }} />
              <div className="shop-info">
                <strong>{item.name}</strong>
                <small className="muted">в сумке: {n}</small>
              </div>
              <span className="price">{sellPrice(item.id)}</span>
              <button className="btn small" type="button" onClick={() => act((g) => sell(g, item.id, 1))}>
                Продать 1
              </button>
            </div>
          ))}
      </div>
    </Modal>
  );
}

export function StorageModal() {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const setModal = useStore((s) => s.setModal);
  const [filter, setFilter] = useState('');
  const list = game.storage.filter((p) => !filter || displayName(p).toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal title={`🏠 Питомник (${game.storage.length})`} onClose={() => setModal(null)} wide>
      <div className="storage-layout">
        <div>
          <h4>Команда ({game.team.length}/6)</h4>
          <div className="team-list">
            {game.team.map((p) => (
              <MonCard key={p.uid} p={p} onClick={() => setModal('pokemon', p.uid)} />
            ))}
          </div>
          <p className="muted hint">Чтобы отправить покемона в питомник, откройте его карточку.</p>
        </div>
        <div>
          <div className="panel-head">
            <h4>В питомнике</h4>
            <input className="search" placeholder="Поиск" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {list.length === 0 && <p className="muted">Пусто. Пойманные при полной команде покемоны попадают сюда.</p>}
          <div className="storage-grid">
            {list.map((p) => (
              <MonCard
                key={p.uid}
                p={p}
                onClick={() => setModal('pokemon', p.uid)}
                footer={
                  <span
                    role="button"
                    tabIndex={0}
                    className="btn small"
                    onClick={(e) => {
                      e.stopPropagation();
                      act((g) => withdraw(g, p.uid));
                    }}
                  >
                    В команду
                  </span>
                }
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function whereFound(id: number): string[] {
  return LOCATION_LIST.filter((l) =>
    [...(l.wild ?? []), ...(l.fishing?.old ?? []), ...(l.fishing?.good ?? [])].some((e) => e.species === id),
  ).map((l) => l.name);
}

export function DexModal() {
  const game = useStore((s) => s.game)!;
  const setModal = useStore((s) => s.setModal);
  const [selected, setSelected] = useState<number | null>(null);
  const seen = Object.keys(game.dex).length;
  const caught = Object.values(game.dex).filter((v) => v === 'caught').length;
  const sel = selected !== null ? getSpecies(selected) : null;
  const known = sel ? !!game.dex[sel.id] : false;
  return (
    <Modal title={<>📕 Покедекс — встречено {seen}, поймано {caught} из {SPECIES_LIST.length}</>} onClose={() => setModal(null)} wide>
      <div className="dex-layout">
        <div className="dex-grid">
          {SPECIES_LIST.map((s) => {
            const st = game.dex[s.id];
            return (
              <button key={s.id} type="button" className={`dex-cell${selected === s.id ? ' active' : ''}${st ? ` ${st}` : ''}`} onClick={() => setSelected(s.id)}>
                <MonIcon species={s.id} size={40} silhouette={!st} />
                <small>{dexNo(s.id)}</small>
                <span>{st ? s.name : '???'}</span>
              </button>
            );
          })}
        </div>
        <div className="dex-detail">
          {!sel && <p className="muted">Выберите покемона слева.</p>}
          {sel && !known && (
            <>
              <h3>{dexNo(sel.id)} ???</h3>
              <p className="muted">Этот покемон ещё не встречался.</p>
              {whereFound(sel.id).length > 0 && <p className="muted">Подсказка: его можно встретить на {whereFound(sel.id).length} локациях.</p>}
            </>
          )}
          {sel && known && (
            <>
              <MonPreview species={sel.id} shiny={false} height={200} />
              <h3>
                {dexNo(sel.id)} {sel.name} <span className="muted">{sel.en}</span>
              </h3>
              <div className="hud-types">
                {sel.types.map((t) => (
                  <TypeBadge key={t} type={t} />
                ))}
                {game.dex[sel.id] === 'caught' && <span className="done-chip">Пойман</span>}
              </div>
              {DEX_INFO[sel.id] && (
                <p className="muted">
                  Рост {DEX_INFO[sel.id].height} м · вес {DEX_INFO[sel.id].weight} кг · шанс поимки {sel.catchRate}
                </p>
              )}
              <table className="stat-table compact">
                <tbody>
                  {STAT_KEYS.map((k) => (
                    <tr key={k}>
                      <td>{STAT_LABELS[k]}</td>
                      <td>
                        <div className="stat-bar">
                          <div style={{ width: `${(sel.base[k] / 160) * 100}%` }} />
                          <span>{sel.base[k]}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sel.evolutions.length > 0 && (
                <p>
                  Эволюция:{' '}
                  {sel.evolutions
                    .map((e) => `${game.dex[e.to] ? getSpecies(e.to).name : '???'} (${e.level ? `ур. ${e.level}` : getItem(e.item!).name})`)
                    .join(', ')}
                </p>
              )}
              <p>Где встречается: {whereFound(sel.id).join(', ') || 'нигде в дикой природе'}</p>
              <details>
                <summary>Атаки по уровням</summary>
                <ul className="learnset">
                  {sel.learnset.map(([lvl, mv]) => (
                    <li key={`${lvl}-${mv}`}>
                      <span className="muted">ур. {lvl}</span> {getMove(mv).name} <TypeBadge type={getMove(mv).type} small />
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function MapModal() {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const setModal = useStore((s) => s.setModal);
  const here = getLocation(game.location);
  const edges = useMemo(() => {
    const seen = new Set<string>();
    const list: [string, string][] = [];
    for (const l of LOCATION_LIST) {
      for (const ex of l.exits) {
        const k = [l.id, ex].sort().join('|');
        if (!seen.has(k)) {
          seen.add(k);
          list.push([l.id, ex]);
        }
      }
    }
    return list;
  }, []);
  const colors: Record<string, string> = {
    town: '#ffd54f', meadow: '#8bd16a', forest: '#3f9a4a', mountain: '#a89a84', cave: '#8a6aff', lake: '#4fa3ff', volcano: '#ff7043', plant: '#b0bec5', hills: '#b2e48c',
  };
  return (
    <Modal title="🗺 Карта региона" onClose={() => setModal(null)} wide>
      <div className="map-wrap">
        <svg viewBox="-8 0 116 96" className="world-map">
          {edges.map(([a, b]) => {
            const A = getLocation(a).pos;
            const B = getLocation(b).pos;
            return <line key={`${a}${b}`} x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} className="map-edge" />;
          })}
          {LOCATION_LIST.map((l) => {
            const isHere = l.id === here.id;
            const adjacent = here.exits.includes(l.id);
            const open = canEnter(game, l.id);
            return (
              <g
                key={l.id}
                transform={`translate(${l.pos[0]} ${l.pos[1]})`}
                className={`map-node${isHere ? ' here' : ''}${adjacent ? ' adjacent' : ''}${open ? '' : ' locked'}`}
                onClick={() => {
                  if (adjacent && act((g) => travel(g, l.id)).ok) setModal(null);
                }}
              >
                {isHere && <circle r={6} className="pulse" />}
                <circle r={l.biome === 'town' ? 4 : 3.2} fill={colors[l.biome]} />
                <text y={7.6} textAnchor="middle">
                  {l.name}
                </text>
                {!open && (
                  <text y={1.4} textAnchor="middle" className="lock">
                    🔒
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div className="map-legend">
          <p>
            Вы здесь: <strong>{here.name}</strong> ({BIOME_LABELS[here.biome]})
          </p>
          <p className="muted">Нажмите на соседнюю локацию, чтобы перейти. Закрытые локации требуют значок стадиона.</p>
          <ul>
            {Object.entries(BADGES).map(([id, b]) => (
              <li key={id}>
                <span className={`badge-gem${game.player.badges.includes(id) ? ' got' : ''}`} style={{ ['--gem' as string]: b.color }} /> {b.name}
                {game.player.badges.includes(id) ? ' — получен' : ''}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const exportSave = useStore((s) => s.exportSave);
  const importSave = useStore((s) => s.importSave);
  const resetGame = useStore((s) => s.resetGame);
  const setModal = useStore((s) => s.setModal);
  const game = useStore((s) => s.game);
  const manifest = useSpriteManifest();
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const spriteCount = manifest ? SPECIES_LIST.filter((s) => manifest[String(s.id)]).length : 0;

  const download = () => {
    const json = exportSave();
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `liga3d-${game?.player.name ?? 'save'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Modal title="⚙ Настройки" onClose={() => setModal(null)}>
      <div className="settings">
        <section>
          <h4>Изображения покемонов</h4>
          <label className="toggle">
            <input type="checkbox" checked={settings.useSprites} onChange={(e) => setSettings({ useSprites: e.target.checked })} />
            <span>Показывать импортированные картинки вместо 3D-моделей</span>
          </label>
          <p className="muted">
            Найдено картинок для {spriteCount} из {SPECIES_LIST.length} покемонов игры.
            {spriteCount === 0 && ' Чтобы добавить свои картинки, распакуйте архив и выполните: npm run import-sprites -- путь/к/архиву'}
          </p>
        </section>
        <section>
          <h4>Скорость боя</h4>
          <div className="seg">
            {([1, 2, 3] as const).map((v) => (
              <button key={v} type="button" className={settings.battleSpeed === v ? 'active' : ''} onClick={() => setSettings({ battleSpeed: v })}>
                ×{v}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h4>Сохранение</h4>
          <p className="muted">Игра сохраняется автоматически в браузере после каждого действия.</p>
          <div className="row-btns">
            <button className="btn" type="button" onClick={download} disabled={!game}>
              Скачать файл сохранения
            </button>
            <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
              Загрузить из файла
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
        </section>
        {game && (
          <section>
            <h4>Статистика</h4>
            <ul className="stats-list">
              <li>Встреч с дикими: {game.stats.encounters}</li>
              <li>Побеждено диких: {game.stats.wildDefeated}</li>
              <li>Поймано: {game.stats.caught}</li>
              <li>Побеждено тренеров: {game.stats.trainersDefeated}</li>
              <li>Встречено шайни: {game.stats.shinySeen}</li>
              <li>Найдено предметов: {game.stats.itemsFound}</li>
              <li>Поражений: {game.stats.losses}</li>
            </ul>
          </section>
        )}
        <section>
          <h4>Новая игра</h4>
          {!confirmReset ? (
            <button className="btn danger" type="button" onClick={() => setConfirmReset(true)}>
              Начать заново
            </button>
          ) : (
            <span className="confirm">
              Текущий прогресс будет удалён. Сначала скачайте сохранение, если оно нужно.
              <button className="btn danger" type="button" onClick={resetGame}>
                Удалить и начать заново
              </button>
              <button className="btn" type="button" onClick={() => setConfirmReset(false)}>
                Отмена
              </button>
            </span>
          )}
        </section>
      </div>
    </Modal>
  );
}

export function LearnMoveModal() {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const pending = game.pendingLearn[0];
  const p = [...game.team, ...game.storage].find((x) => x.uid === pending?.uid);
  if (!pending || !p) return null;
  const nm = getMove(pending.moveId);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>Новая атака</h2>
        </div>
        <div className="modal-body">
          <p>
            <strong>{displayName(p)}</strong> хочет выучить «{nm.name}» ({TYPE_INFO[nm.type].name}
            {nm.power ? `, сила ${nm.power}` : ''}), но уже знает 4 атаки. Какую забыть?
          </p>
          <div className="learn-list">
            {p.moves.map((m, i) => {
              const mv = getMove(m.id);
              return (
                <button key={m.id} type="button" className="move-row clickable" style={{ ['--type' as string]: TYPE_INFO[mv.type].color }} onClick={() => act((g) => resolveLearn(g, i))}>
                  <span className="move-name">{mv.name}</span>
                  <TypeBadge type={mv.type} small />
                  <span>{mv.power || '—'}</span>
                  <span>
                    PP {m.pp}/{m.maxPp}
                  </span>
                </button>
              );
            })}
          </div>
          <button className="btn ghost" type="button" onClick={() => act((g) => resolveLearn(g, null))}>
            Не учить «{nm.name}»
          </button>
        </div>
      </div>
    </div>
  );
}

export function EvolutionModal() {
  const game = useStore((s) => s.game)!;
  const act = useStore((s) => s.act);
  const pending = game.pendingEvolution[0];
  const p = game.team.find((x) => x.uid === pending?.uid);
  const [phase, setPhase] = useState<'ask' | 'glow'>('ask');
  useEffect(() => setPhase('ask'), [pending?.uid, pending?.to]);
  if (!pending || !p) return null;
  const to = getSpecies(pending.to);
  return (
    <div className="modal-backdrop">
      <div className="modal evolution" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>Что? {displayName(p)} эволюционирует!</h2>
        </div>
        <div className={`modal-body evo-body ${phase}`}>
          <div className="evo-stage">
            <MonPreview species={phase === 'glow' ? pending.to : p.species} shiny={p.shiny} height={240} />
            {phase === 'glow' && <div className="evo-flash" />}
          </div>
          {phase === 'ask' ? (
            <div className="row-btns">
              <button
                className="btn primary big"
                type="button"
                onClick={() => {
                  setPhase('glow');
                  setTimeout(() => act((g) => resolveEvolution(g, true), { quiet: false }), 1600);
                }}
              >
                Эволюция → {to.name}
              </button>
              <button className="btn ghost" type="button" onClick={() => act((g) => resolveEvolution(g, false))}>
                Остановить эволюцию
              </button>
            </div>
          ) : (
            <p className="evo-text">✨ {to.name}! ✨</p>
          )}
        </div>
      </div>
    </div>
  );
}
