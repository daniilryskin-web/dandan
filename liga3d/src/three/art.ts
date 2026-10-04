import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { loadSprite, spriteUrl, useSpriteManifest, type SpriteImage } from './sprites';

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites';

export type ArtSource = 'home' | 'artwork' | 'models';

/** Pokémon HOME 3D render (512×512, transparent) from the PokeAPI sprite repository. */
export function homeUrl(id: number, shiny: boolean): string {
  return `${SPRITES}/pokemon/other/home/${shiny ? 'shiny/' : ''}${id}.png`;
}

export function artworkUrl(id: number, shiny: boolean): string {
  return `${SPRITES}/pokemon/other/official-artwork/${shiny ? 'shiny/' : ''}${id}.png`;
}

export function typeIconUrl(typeIndex: number): string {
  return `${SPRITES}/types/generation-ix/scarlet-violet/${typeIndex}.png`;
}

export function cryUrl(id: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${id}.ogg`;
}

export type ArtState = { status: 'loading' } | { status: 'ready'; image: SpriteImage } | { status: 'none' };

/** Picks the image for a Pokémon: locally imported sprite → HOME render / artwork → none (use the 3D model). */
export function usePokemonArt(id: number, shiny: boolean, sourceOverride?: ArtSource): ArtState {
  const settingSource = useStore((s) => s.settings.artSource);
  const source = sourceOverride ?? settingSource;
  const manifest = useSpriteManifest();
  const [state, setState] = useState<ArtState>({ status: 'loading' });
  const local = manifest ? spriteUrl(manifest, id) : null;
  useEffect(() => {
    let alive = true;
    if (source === 'models') {
      setState({ status: 'none' });
      return;
    }
    if (manifest === null) {
      setState({ status: 'loading' });
      return;
    }
    setState({ status: 'loading' });
    const remote = source === 'artwork' ? artworkUrl(id, shiny) : homeUrl(id, shiny);
    const first = local ? loadSprite(local, shiny) : loadSprite(remote, false);
    first
      .catch(() => (local ? loadSprite(remote, false) : Promise.reject(new Error('no art'))))
      .then((image) => alive && setState({ status: 'ready', image }))
      .catch(() => alive && setState({ status: 'none' }));
    return () => {
      alive = false;
    };
  }, [id, shiny, source, local, manifest]);
  return state;
}

/** World-space height of a Pokémon picture, from its real height in metres (trainer ≈ 1.7). */
export function worldHeight(heightM: number, min = 0.9, max = 6.5): number {
  return Math.max(min, Math.min(max, heightM * 1.25 + 0.35));
}
