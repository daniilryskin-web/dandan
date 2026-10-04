import { useStore } from '../state/store';
import { cryUrl } from '../three/art';

function enabled(): boolean {
  return useStore.getState().settings.sound;
}

/** Plays the Pokémon's cry from the PokeAPI cries repository. */
export function playCry(species: number, { rate = 1, volume = 0.32 }: { rate?: number; volume?: number } = {}) {
  if (!enabled() || typeof Audio === 'undefined') return;
  try {
    const a = new Audio(cryUrl(species));
    a.volume = volume;
    a.playbackRate = rate;
    (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = false;
    void a.play().catch(() => undefined);
  } catch {
    /* audio is optional */
  }
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (!enabled()) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, gain: number, slide = 0) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + at);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), c.currentTime + at + dur);
  g.gain.setValueAtTime(0.0001, c.currentTime + at);
  g.gain.exponentialRampToValueAtTime(gain, c.currentTime + at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur + 0.02);
}

function noise(c: AudioContext, at: number, dur: number, gain: number, freq = 1200) {
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(c.currentTime + at);
}

export type Sfx = 'select' | 'back' | 'hit' | 'super' | 'weak' | 'crit' | 'heal' | 'up' | 'down' | 'throw' | 'shake' | 'caught' | 'escape' | 'faint' | 'level';

/** Tiny synthesized UI / battle sound effects (no audio files needed). */
export function sfx(kind: Sfx) {
  const c = audio();
  if (!c) return;
  switch (kind) {
    case 'select':
      tone(c, 880, 0, 0.06, 'square', 0.05);
      tone(c, 1320, 0.05, 0.08, 'square', 0.04);
      break;
    case 'back':
      tone(c, 660, 0, 0.07, 'square', 0.04, 0.7);
      break;
    case 'hit':
      noise(c, 0, 0.16, 0.5, 1800);
      tone(c, 140, 0, 0.12, 'sine', 0.25, 0.5);
      break;
    case 'weak':
      noise(c, 0, 0.12, 0.25, 900);
      break;
    case 'super':
    case 'crit':
      noise(c, 0, 0.22, 0.65, 3200);
      tone(c, 180, 0, 0.2, 'sawtooth', 0.18, 0.4);
      noise(c, 0.08, 0.18, 0.4, 2400);
      break;
    case 'heal':
      [523, 659, 784, 1047].forEach((f, i) => tone(c, f, i * 0.07, 0.18, 'sine', 0.08));
      break;
    case 'up':
      [440, 554, 659, 880].forEach((f, i) => tone(c, f, i * 0.05, 0.12, 'triangle', 0.07));
      break;
    case 'down':
      [880, 659, 554, 440].forEach((f, i) => tone(c, f, i * 0.05, 0.12, 'triangle', 0.07));
      break;
    case 'throw':
      tone(c, 300, 0, 0.35, 'sine', 0.08, 3);
      break;
    case 'shake':
      tone(c, 220, 0, 0.05, 'square', 0.06);
      tone(c, 180, 0.06, 0.05, 'square', 0.05);
      break;
    case 'caught':
      [784, 988, 1175, 1568].forEach((f, i) => tone(c, f, i * 0.11, 0.25, 'square', 0.05));
      break;
    case 'escape':
      tone(c, 900, 0, 0.25, 'square', 0.05, 0.4);
      break;
    case 'faint':
      tone(c, 420, 0, 0.6, 'triangle', 0.1, 0.25);
      break;
    case 'level':
      [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(c, f, i * 0.09, 0.16, 'square', 0.05));
      break;
  }
}
