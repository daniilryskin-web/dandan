import { useEffect, useState, type ReactNode } from 'react';
import { STATUS_INFO, type StatusId } from '../data/moves';
import { getSpecies } from '../data/species';
import { TYPE_INFO, type PokeType } from '../data/types';
import type { Pokemon } from '../engine/model';
import { displayName, expProgress, maxHp } from '../engine/pokemon';
import { paletteFor } from '../three/CreatureModel';
import { loadSprite, spriteUrl, useSpriteManifest } from '../three/sprites';
import { useStore } from '../state/store';

export function TypeBadge({ type, small }: { type: PokeType; small?: boolean }) {
  const info = TYPE_INFO[type];
  return (
    <span className={`type-badge${small ? ' small' : ''}`} style={{ background: info.color }}>
      {info.name}
    </span>
  );
}

export function StatusBadge({ status }: { status: StatusId | null }) {
  if (!status) return null;
  const s = STATUS_INFO[status];
  return (
    <span className="status-badge" style={{ background: s.color }} title={s.name}>
      {s.short}
    </span>
  );
}

export function hpColor(ratio: number): string {
  if (ratio > 0.5) return 'var(--hp-good)';
  if (ratio > 0.2) return 'var(--hp-mid)';
  return 'var(--hp-low)';
}

export function HpBar({ hp, max, showNumbers = true }: { hp: number; max: number; showNumbers?: boolean }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  return (
    <div className="hpbar-wrap">
      <div className="hpbar">
        <div className="hpbar-fill" style={{ width: `${ratio * 100}%`, background: hpColor(ratio) }} />
      </div>
      {showNumbers && (
        <span className="hpbar-num">
          {Math.max(0, hp)}/{max}
        </span>
      )}
    </div>
  );
}

export function ExpBar({ p }: { p: Pokemon }) {
  const e = expProgress(p);
  return (
    <div className="expbar" title={`Опыт: ${e.current}/${e.needed}`}>
      <div className="expbar-fill" style={{ width: `${e.ratio * 100}%` }} />
    </div>
  );
}

export function GenderMark({ gender }: { gender: Pokemon['gender'] }) {
  if (!gender) return null;
  return <span className={`gender ${gender === 'M' ? 'm' : 'f'}`}>{gender === 'M' ? '♂' : '♀'}</span>;
}

/** Small 2D picture: imported image when available, otherwise a stylised token in the species colours. */
export function MonIcon({ species, shiny = false, size = 44, silhouette = false }: { species: number; shiny?: boolean; size?: number; silhouette?: boolean }) {
  const useSprites = useStore((s) => s.settings.useSprites);
  const manifest = useSpriteManifest();
  const url = useSprites ? spriteUrl(manifest, species) : null;
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setImg(null);
    if (url) loadSprite(url, shiny).then((s) => alive && setImg(s.dataUrl)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url, shiny]);
  const sp = getSpecies(species);
  if (img) {
    return (
      <img
        className="mon-icon img"
        src={img}
        alt={sp.name}
        width={size}
        height={size}
        style={{ filter: silhouette ? 'brightness(0) opacity(0.55)' : undefined }}
      />
    );
  }
  const pal = paletteFor(sp.look, shiny);
  return (
    <span
      className="mon-icon token"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: silhouette ? '#262a38' : `radial-gradient(circle at 35% 30%, ${pal.belly}, ${pal.body} 55%, ${pal.accent})`,
        color: silhouette ? '#59607a' : '#ffffffee',
      }}
      title={silhouette ? '???' : sp.name}
    >
      {silhouette ? '?' : sp.name[0]}
    </span>
  );
}

export function MonLine({ p }: { p: Pokemon }) {
  const sp = getSpecies(p.species);
  return (
    <div className="mon-line">
      <span className="mon-name">
        {p.shiny && <span className="shiny-star" title="Шайни">✦</span>}
        {displayName(p)}
        <GenderMark gender={p.gender} />
      </span>
      <span className="mon-level">ур. {p.level}</span>
      <span className="mon-types">
        {sp.types.map((t) => (
          <TypeBadge key={t} type={t} small />
        ))}
      </span>
    </div>
  );
}

export function MonCard({ p, onClick, active, footer }: { p: Pokemon; onClick?: () => void; active?: boolean; footer?: ReactNode }) {
  const mhp = maxHp(p);
  return (
    <button className={`mon-card${active ? ' active' : ''}${p.hp <= 0 ? ' fainted' : ''}`} onClick={onClick} type="button">
      <MonIcon species={p.species} shiny={p.shiny} />
      <div className="mon-card-body">
        <MonLine p={p} />
        <div className="mon-card-hp">
          <HpBar hp={p.hp} max={mhp} />
          <StatusBadge status={p.status} />
        </div>
        <ExpBar p={p} />
        {footer}
      </div>
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть" type="button">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Money({ value }: { value: number }) {
  return (
    <span className="money" title="Монеты">
      <span className="coin" aria-hidden="true" />
      {value.toLocaleString('ru-RU')}
    </span>
  );
}
