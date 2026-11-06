/** Client-side state. Kept deliberately small: the daemon is the source of truth, this only caches
 *  the last responses plus the user's unsaved config draft. */

const HISTORY_LENGTH = 600;

export const state = {
  authenticated: false,
  authRequired: false,
  me: null,
  status: null,
  devices: [],
  deviceId: null,
  info: null,
  infoRows: [],
  stats: null,
  config: null,
  draft: null,
  profiles: null,
  activeProfile: null,
  daemonConnected: false,
  pageId: "info",
  history: createHistory(),
};

export function createHistory() {
  return {
    temp: [],
    power: [],
    core: [],
    mem: [],
    fan: [],
    vram: [],
    busy: [],
  };
}

export function resetHistory() {
  state.history = createHistory();
}

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function set(partial, reason = "update") {
  Object.assign(state, partial);
  for (const listener of listeners) listener(reason);
}

/** Primary temperature sensor: the daemon marks one entry as `primary`. */
export function primaryTemp(stats) {
  if (!stats || !stats.temps) return null;
  const entries = Object.entries(stats.temps);
  if (entries.length === 0) return null;
  const primary = entries.find(([, value]) => value.primary !== false);
  const [, entry] = primary || entries[0];
  return typeof entry === "object" ? entry.value : entry;
}

export function recordHistory(stats) {
  if (!stats) return;

  const push = (series, value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    series.push(Number(value));
    if (series.length > HISTORY_LENGTH) series.shift();
  };

  push(state.history.temp, primaryTemp(stats));
  push(state.history.power, stats.power?.average ?? stats.power?.current);
  push(state.history.core, stats.clockspeed?.gpu_clockspeed);
  push(state.history.mem, stats.clockspeed?.vram_clockspeed);
  push(state.history.fan, stats.fan?.speed_current);
  push(
    state.history.vram,
    stats.vram?.used && stats.vram?.total ? (stats.vram.used / stats.vram.total) * 100 : null,
  );
  push(state.history.busy, stats.busy_percent);
}

/** Recompute whether the draft differs from what the daemon reported. */
export function isDirty() {
  if (!state.draft || !state.config) return state.draft !== state.config;
  return JSON.stringify(state.draft) !== JSON.stringify(state.config);
}

export function deviceLabel(device) {
  return device?.name || device?.id || "Unknown GPU";
}
