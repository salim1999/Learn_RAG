// RAG Academy – geteilter Client-Zustand (Status, Fortschritt) mit Abonnenten

import { api } from './api.js';

export const RANKS = [
  { xp: 0, name: 'Token-Lehrling' },
  { xp: 150, name: 'Chunk-Schmied' },
  { xp: 400, name: 'Vektor-Navigator' },
  { xp: 800, name: 'Retrieval-Ritter' },
  { xp: 1300, name: 'Grounding-Wächter' },
  { xp: 2000, name: 'RAG-Architekt' },
  { xp: 3000, name: 'Halluzinations-Bezwinger' },
];

const listeners = new Set();

export const state = {
  status: null,
  progress: null,
  statusError: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(change) {
  for (const fn of listeners) {
    try { fn(state, change); } catch (e) { console.error(e); }
  }
}

export async function loadStatus() {
  try {
    state.status = await api.status();
    state.statusError = null;
  } catch (err) {
    state.status = null;
    state.statusError = err;
  }
  emit({ type: 'status' });
  return state.status;
}

export async function loadProgress() {
  try {
    const p = await api.progress();
    setProgress(p);
  } catch (err) {
    console.warn('Fortschritt nicht ladbar', err);
  }
  return state.progress;
}

/** Neuen Fortschritt übernehmen; meldet neu erhaltene Badges & Rangwechsel. */
export function setProgress(p) {
  if (!p) return;
  const prev = state.progress;
  state.progress = p;
  const change = { type: 'progress', newBadges: [], rankUp: null, xpGain: 0 };
  if (prev && prev.player && p.player) {
    const had = new Set((prev.player.badges || []).map((b) => b.id));
    change.newBadges = (p.player.badges || []).filter((b) => !had.has(b.id));
    if (prev.player.rank !== p.player.rank) change.rankUp = p.player.rank;
    change.xpGain = (p.player.xp || 0) - (prev.player.xp || 0);
  }
  emit(change);
}

export function rankInfo(player) {
  const xp = (player && player.xp) || 0;
  let cur = RANKS[0];
  for (const r of RANKS) if (xp >= r.xp) cur = r;
  const nextXp = player && player.next_rank_xp != null
    ? player.next_rank_xp
    : (RANKS.find((r) => r.xp > xp) || {}).xp ?? null;
  const next = RANKS.find((r) => r.xp === nextXp) || RANKS.find((r) => r.xp > xp) || null;
  const span = nextXp != null ? nextXp - cur.xp : 1;
  const frac = nextXp != null ? Math.max(0, Math.min(1, (xp - cur.xp) / (span || 1))) : 1;
  return { xp, rank: (player && player.rank) || cur.name, nextXp, nextName: next ? next.name : null, frac };
}

export function levelProgress(levelId) {
  const lv = state.progress && state.progress.levels && state.progress.levels[String(levelId)];
  return lv || { unlocked: Number(levelId) === 1, score_pct: 0, stars: 0, best_scores: {} };
}

/* ---------- Level-Cache (für Level- und Aufgaben-Ansicht) ---------- */
const levelCache = new Map();

export async function getLevel(id, { force = false } = {}) {
  const key = String(id);
  if (!force && levelCache.has(key)) return levelCache.get(key);
  const lvl = await api.level(id);
  levelCache.set(key, lvl);
  return lvl;
}

export function clearLevelCache() {
  levelCache.clear();
}
