// Built-in levels + a localStorage store for ones authored in the builder.
// A level is { id, name, targets: { pieceId: [x, y, rotation] } }. Positions are
// re-centred on the board at load time, so absolute coordinates don't matter.

export const BUILTIN_LEVELS = [
  { id: 'house', name: 'The House', targets: { mountain: [420, 220, 180], shadow: [420, 220, 270], reed: [360, 220, 45], stone: [480, 220, 0], bridge: [360, 220, 0], wing: [300, 220, 360], beak: [480, 220, 90] } },
  { id: 'mountain_fig', name: 'Mountain', targets: { mountain: [120, 0, 90], shadow: [120, 0, 0], reed: [120, 120, 135], wing: [0, 60, 270], beak: [0, 120, 0], stone: [0, 60, 0], bridge: [0, 240, 270] } },
  { id: 'rectangle', name: 'Rectangle', targets: { mountain: [0, 0, 0], shadow: [120, 120, 180], reed: [180, 60, 225], wing: [120, 60, 270], stone: [120, 60, 0], bridge: [180, 120, 270], beak: [240, 120, 180] } },
  { id: 'diamond', name: 'Diamond', targets: { mountain: [120, 120, 180], shadow: [120, 120, 90], reed: [240, 120, 135], bridge: [120, 240, 270], wing: [120, 60, 270], beak: [120, 120, 0], stone: [120, 60, 0] } },
  { id: 'tower', name: 'Tower', targets: { mountain: [0, 0, 0], shadow: [120, 120, 180], reed: [60, 180, 225], wing: [0, 180, 270], stone: [0, 180, 0], bridge: [60, 240, 270], beak: [120, 240, 180] } },
  { id: 'staircase', name: 'Staircase', targets: { mountain: [0, 0, 0], shadow: [120, 180, 180], reed: [120, 0, 45], wing: [60, 60, 0], beak: [180, 0, 90], stone: [180, 0, 0], bridge: [0, 180, 270] } }
];

const KEY = 'ma_tangram_custom_levels_v1';

export function getCustomLevels() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

export function saveCustomLevel(level) {
  const all = getCustomLevels();
  const i = all.findIndex((l) => l.id === level.id);
  if (i >= 0) all[i] = level; else all.push(level);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

export function deleteCustomLevel(id) {
  const all = getCustomLevels().filter((l) => l.id !== id);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

export function allLevels() {
  return [...BUILTIN_LEVELS, ...getCustomLevels()];
}
