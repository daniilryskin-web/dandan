import { useEffect, useState } from 'react';
import * as THREE from 'three';

/** speciesId -> file name inside ./sprites/, produced by scripts/import-sprites.mjs. */
type Manifest = Record<string, string>;

let manifestPromise: Promise<Manifest> | null = null;
let manifestValue: Manifest | null = null;

export function loadManifest(): Promise<Manifest> {
  if (!manifestPromise) {
    manifestPromise = fetch('./sprites/manifest.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((m: Manifest) => {
        manifestValue = m && typeof m === 'object' ? m : {};
        return manifestValue;
      });
  }
  return manifestPromise;
}

export function useSpriteManifest(): Manifest | null {
  const [m, setM] = useState<Manifest | null>(manifestValue);
  useEffect(() => {
    let alive = true;
    loadManifest().then((v) => alive && setM(v));
    return () => {
      alive = false;
    };
  }, []);
  return m;
}

export function spriteUrl(manifest: Manifest | null, speciesId: number): string | null {
  const f = manifest?.[String(speciesId)];
  return f ? `./sprites/${f}` : null;
}

export interface SpriteImage {
  texture: THREE.Texture;
  aspect: number;
  dataUrl: string;
}

const cache = new Map<string, Promise<SpriteImage>>();

/** Removes a flat background colour that touches the image border (white/black JPEG backgrounds). */
export function removeBackground(data: ImageData): void {
  const { width: w, height: h, data: px } = data;
  let transparent = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 20) transparent++;
  if (transparent > w * h * 0.02) return;

  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const buckets = new Map<number, number>();
  for (const i of border) {
    const k = ((px[i * 4] >> 4) << 8) | ((px[i * 4 + 1] >> 4) << 4) | (px[i * 4 + 2] >> 4);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  let bestKey = 0;
  let bestCount = 0;
  for (const [k, c] of buckets) if (c > bestCount) [bestKey, bestCount] = [k, c];
  if (bestCount < border.length * 0.5) return;
  let r = 0, g = 0, b = 0, n = 0;
  for (const i of border) {
    const k = ((px[i * 4] >> 4) << 8) | ((px[i * 4 + 1] >> 4) << 4) | (px[i * 4 + 2] >> 4);
    if (k !== bestKey) continue;
    r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  const dist = (i: number) => Math.abs(px[i * 4] - r) + Math.abs(px[i * 4 + 1] - g) + Math.abs(px[i * 4 + 2] - b);

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const i of border) if (!seen[i] && dist(i) < 60) { seen[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    px[i * 4 + 3] = 0;
    const x = i % w;
    const y = (i / w) | 0;
    const near = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of near) {
      if (j < 0 || seen[j]) continue;
      if (dist(j) < 60) { seen[j] = 1; stack.push(j); }
      else if (dist(j) < 120) { seen[j] = 2; px[j * 4 + 3] = Math.min(px[j * 4 + 3], 140); }
    }
  }
}

function hueShift(data: ImageData, amount: number): void {
  const c = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 10) continue;
    c.setRGB(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    c.getHSL(hsl);
    c.setHSL((hsl.h + amount) % 1, hsl.s, hsl.l);
    px[i] = c.r * 255; px[i + 1] = c.g * 255; px[i + 2] = c.b * 255;
  }
}

/** Loads a sprite, cuts out its background, trims it and optionally recolours it for shiny. */
export function loadSprite(url: string, shiny: boolean): Promise<SpriteImage> {
  const key = `${url}|${shiny ? 1 : 0}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise<SpriteImage>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const max = 256;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * k));
        const h = Math.max(1, Math.round(img.height * k));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        removeBackground(data);
        if (shiny) hueShift(data, 0.42);
        // Trim to the visible area.
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (data.data[(y * w + x) * 4 + 3] > 24) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        ctx.putImageData(data, 0, 0);
        const tw = x1 >= x0 ? x1 - x0 + 1 : w;
        const th = y1 >= y0 ? y1 - y0 + 1 : h;
        const out = document.createElement('canvas');
        out.width = tw;
        out.height = th;
        out.getContext('2d')!.drawImage(canvas, x1 >= x0 ? x0 : 0, y1 >= y0 ? y0 : 0, tw, th, 0, 0, tw, th);
        const texture = new THREE.CanvasTexture(out);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        resolve({ texture, aspect: tw / th, dataUrl: out.toDataURL('image/png') });
      };
      img.onerror = () => reject(new Error(`Не удалось загрузить ${url}`));
      img.src = url;
    });
    cache.set(key, p);
  }
  return p;
}

export function useSprite(speciesId: number, shiny: boolean, enabled: boolean): SpriteImage | null {
  const manifest = useSpriteManifest();
  const url = enabled ? spriteUrl(manifest, speciesId) : null;
  const [sprite, setSprite] = useState<SpriteImage | null>(null);
  useEffect(() => {
    let alive = true;
    setSprite(null);
    if (!url) return;
    loadSprite(url, shiny)
      .then((s) => alive && setSprite(s))
      .catch(() => alive && setSprite(null));
    return () => {
      alive = false;
    };
  }, [url, shiny]);
  return sprite;
}
