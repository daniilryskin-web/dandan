import { create } from 'zustand';

/** A wild Pokémon walking around the overworld. */
export interface Spawn {
  id: number;
  species: number;
  level: number;
  shiny: boolean;
  x: number;
  z: number;
  homeX: number;
  homeZ: number;
  tx: number;
  tz: number;
  wait: number;
  heading: number;
  inWater: boolean;
  bold: boolean;
  bornAt: number;
}

export interface Pickup {
  id: number;
  item: string;
  x: number;
  z: number;
}

/**
 * Mutable per-frame world data. Kept outside React state so that movement does not re-render the UI,
 * and so the overworld survives being unmounted while a battle is shown.
 */
export const runtime = {
  loc: '',
  from: null as string | null,
  player: { x: 0, z: 0, rot: 0, speed: 0 },
  cameraYaw: 0,
  cameraPitch: 0.5,
  cameraDist: 11,
  spawns: new Map<number, Spawn>(),
  pickups: new Map<number, Pickup>(),
  nextId: 1,
  /** Set while a battle/travel is being started so contacts don't fire twice. */
  lock: false,
  terrain: null as import('three').Object3D | null,
  /** Where the current battle takes place: the player's spot and the direction to the opponent. */
  battleSpot: null as { loc: string; x: number; z: number; dir: number } | null,
};

export interface PromptAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface Prompt {
  key: string;
  title: string;
  subtitle?: string;
  actions: PromptAction[];
}

interface WorldUi {
  spawnIds: number[];
  pickupIds: number[];
  prompt: Prompt | null;
  syncSpawns: () => void;
  syncPickups: () => void;
  setPrompt: (p: Prompt | null) => void;
}

export const useWorld = create<WorldUi>((set, get) => ({
  spawnIds: [],
  pickupIds: [],
  prompt: null,
  syncSpawns: () => set({ spawnIds: [...runtime.spawns.keys()] }),
  syncPickups: () => set({ pickupIds: [...runtime.pickups.keys()] }),
  setPrompt: (p) => {
    const cur = get().prompt;
    if ((cur?.key ?? null) !== (p?.key ?? null)) set({ prompt: p });
  },
}));

/** Keyboard / joystick / click-to-move state. */
export const input = {
  keys: new Set<string>(),
  joy: { x: 0, y: 0 },
  target: null as [number, number] | null,
  interact: false,
};

export function resetWorld(loc: string, from: string | null) {
  runtime.loc = loc;
  runtime.from = from;
  runtime.spawns.clear();
  runtime.pickups.clear();
  runtime.lock = false;
  input.target = null;
}
