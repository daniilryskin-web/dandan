import { TYPE_INFO, type PokeType } from '../data/types';

/** Simple 24×24 glyphs for each type, drawn in white on the type colour. */
const GLYPHS: Record<PokeType, string> = {
  normal: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zm0 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8z',
  fire: 'M12 2c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5c0 2 1 3 2 3c0-3-1-5.5 1-8.5z',
  water: 'M12 2c3 5 6 8.5 6 12a6 6 0 0 1-12 0c0-3.5 3-7 6-12z',
  electric: 'M13 2L5 13h5l-1 9l8-11h-5z',
  grass: 'M5 19c0-8 5-13 14-14c-1 9-6 14-14 14zm2-1c3-4 6-7 10-10c-4 2-8 5-10 10z',
  ice: 'M11 2h2v5.3l3.6-2.1l1 1.7L14 9l3.6 2.1l-1 1.7L13 10.7V13h-2v-2.3l-3.6 2.1l-1-1.7L10 9L6.4 6.9l1-1.7L11 7.3zM11 14h2v8h-2z',
  fighting: 'M7 9V6a2 2 0 0 1 4 0v3h1V5a2 2 0 0 1 4 0v4a2 2 0 0 1 2 2v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-4a2 2 0 0 1 2-2z',
  poison: 'M12 3a6 6 0 0 1 6 6c0 2.5-1.5 4-3 5v2H9v-2c-1.5-1-3-2.5-3-5a6 6 0 0 1 6-6zM10 9a1.3 1.3 0 1 0 0 .01zM14 9a1.3 1.3 0 1 0 0 .01zM9 18h6v3H9z',
  ground: 'M2 19l6-9l3 4l4-7l7 12z',
  flying: 'M3 14c4-1 7-4 9-9c1 3 1 6-1 9c3-1 6-1 10 0c-5 2-9 5-18 0z',
  psychic: 'M12 4c4.4 0 8 3.6 8 8s-3.6 8-8 8a6 6 0 0 1 0-12a4 4 0 0 1 0 8a2 2 0 0 1 0-4',
  bug: 'M9 6a3 3 0 0 1 6 0v1h1.5l2-2l1 1l-2 2V9h3v2h-3v2l2 2l-1 1l-2-2H16a4 4 0 0 1-8 0H7.5l-2 2l-1-1l2-2v-2h-3V9h3V8l-2-2l1-1l2 2H8V6z',
  rock: 'M6 7l6-4l7 5l-1 9l-7 4l-6-5z',
  ghost: 'M12 3a7 7 0 0 1 7 7v11l-2.5-2l-2.2 2l-2.3-2l-2.3 2l-2.2-2L5 21V10a7 7 0 0 1 7-7zm-2.5 6a1.5 1.5 0 1 0 0 .01zm5 0a1.5 1.5 0 1 0 0 .01z',
  dragon: 'M4 18c2-6 6-10 13-12c-2 2-2 4-1 6c2-1 3-1 4-1c-3 3-7 6-16 7zm9-8l3-1',
  dark: 'M14 3a9 9 0 1 0 7 13a7 7 0 0 1-7-13z',
  steel: 'M12 2l2 3.3l3.8-.6l.6 3.8L22 12l-3.6 3.5l-.6 3.8l-3.8-.6L12 22l-2-3.3l-3.8.6l-.6-3.8L2 12l3.6-3.5l.6-3.8l3.8.6zm0 6.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
  fairy: 'M12 2l2.6 6.6L21 9.3l-5 4.4l1.6 6.8L12 17l-5.6 3.5l1.6-6.8l-5-4.4l6.4-.7z',
};

export function TypeGlyph({ type, size = 16 }: { type: PokeType; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={GLYPHS[type]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** Scarlet/Violet-style type pill: glyph + Russian name. */
export function TypePill({ type, compact = false }: { type: PokeType; compact?: boolean }) {
  const info = TYPE_INFO[type];
  return (
    <span className={`type-pill${compact ? ' compact' : ''}`} style={{ ['--type' as string]: info.color }} title={info.name}>
      <span className="tp-glyph">
        <TypeGlyph type={type} size={compact ? 12 : 14} />
      </span>
      {!compact && <span className="tp-text">{info.name}</span>}
    </span>
  );
}
