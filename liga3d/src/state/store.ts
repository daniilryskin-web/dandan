import { produce } from 'immer';
import { create } from 'zustand';
import * as A from '../engine/actions';
import { battleTurn, closeBattle, forceSwitch, type BattleAction } from '../engine/battle';
import type { GameState } from '../engine/model';
import { defaultRng } from '../engine/rng';
import { clearStorage, deserialize, loadFromStorage, saveToStorage, serialize } from '../engine/save';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error' | 'rare';
}

export type Quality = 'high' | 'medium' | 'low';

export interface Settings {
  useSprites: boolean;
  battleSpeed: 1 | 2 | 3;
  /** Pokémon images: HOME renders, official artwork or procedural 3D models (offline). */
  artSource: 'home' | 'artwork' | 'models';
  quality: Quality;
  sound: boolean;
}

const DEFAULT_SETTINGS: Settings = { useSprites: true, battleSpeed: 1, artSource: 'home', quality: 'high', sound: true };

export type ModalId = 'team' | 'bag' | 'shop' | 'storage' | 'dex' | 'map' | 'settings' | 'pokemon' | null;

const SETTINGS_KEY = 'liga3d-settings';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

interface Store {
  game: GameState | null;
  toasts: Toast[];
  settings: Settings;
  modal: ModalId;
  modalArg: string | null;
  setModal: (m: ModalId, arg?: string | null) => void;
  setSettings: (s: Partial<Settings>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  newGame: (name: string, starter: number) => void;
  loadSaved: () => boolean;
  importSave: (json: string) => boolean;
  exportSave: () => string | null;
  resetGame: () => void;
  /** Runs a world action, shows its message and autosaves. */
  act: (fn: (g: GameState) => A.ActionResult, opts?: { quiet?: boolean }) => A.ActionResult;
  battle: (action: BattleAction) => void;
  forceSwitch: (index: number) => void;
  closeBattle: () => void;
}

let toastId = 1;

export const useStore = create<Store>((set, get) => ({
  game: null,
  toasts: [],
  settings: loadSettings(),
  modal: null,
  modalArg: null,

  setModal: (modal, arg = null) => set({ modal, modalArg: arg }),

  setSettings: (s) => {
    const settings = { ...get().settings, ...s };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    set({ settings });
  },

  toast: (text, kind = 'ok') => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 3500 : 2800);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  newGame: (name, starter) => {
    const game = A.newGame(name, starter, defaultRng);
    saveToStorage(game);
    set({ game, modal: null });
  },

  loadSaved: () => {
    const game = loadFromStorage();
    if (game) set({ game });
    return !!game;
  },

  importSave: (json) => {
    try {
      const game = deserialize(json);
      saveToStorage(game);
      set({ game, modal: null });
      get().toast('Сохранение загружено.');
      return true;
    } catch (e) {
      get().toast(e instanceof Error ? e.message : 'Не удалось загрузить сохранение', 'error');
      return false;
    }
  },

  exportSave: () => {
    const g = get().game;
    return g ? serialize(g) : null;
  },

  resetGame: () => {
    clearStorage();
    set({ game: null, modal: null });
  },

  act: (fn, opts = {}) => {
    const g = get().game;
    if (!g) return { ok: false, message: 'Нет игры' };
    let result: A.ActionResult = { ok: false, message: '' };
    const next = produce(g, (draft) => {
      result = fn(draft as GameState);
    });
    set({ game: next });
    saveToStorage(next);
    if (!opts.quiet && result.message && !result.battle) get().toast(result.message, result.ok ? 'ok' : 'error');
    return result;
  },

  battle: (action) => {
    const g = get().game;
    if (!g) return;
    try {
      const next = produce(g, (draft) => {
        battleTurn(draft as GameState, action, defaultRng);
      });
      set({ game: next });
      saveToStorage(next);
    } catch (e) {
      get().toast(e instanceof Error ? e.message : 'Ошибка', 'error');
    }
  },

  forceSwitch: (index) => {
    const g = get().game;
    if (!g) return;
    try {
      const next = produce(g, (draft) => {
        forceSwitch(draft as GameState, index);
      });
      set({ game: next });
      saveToStorage(next);
    } catch (e) {
      get().toast(e instanceof Error ? e.message : 'Ошибка', 'error');
    }
  },

  closeBattle: () => {
    const g = get().game;
    if (!g) return;
    const next = produce(g, (draft) => {
      closeBattle(draft as GameState);
    });
    set({ game: next });
    saveToStorage(next);
  },
}));
