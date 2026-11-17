import { useSyncExternalStore } from 'react';
import { applyEvent, foldEvents, initialState, type EventEnvelope, type RunState } from '@synape/core';
import { api, streamRun } from './api';

/**
 * Client run store. The live state is folded from the server's event stream
 * with the SAME reducer the engine uses; replay folds the persisted log up to
 * a cursor. Nothing here invents state.
 */
export interface Selection {
  kind: 'task' | 'agent';
  id: string;
}

interface StoreState {
  runId: string | null;
  live: RunState | null;
  /** When set, the UI shows history at this sequence number. */
  cursor: number | null;
  replay: RunState | null;
  events: EventEnvelope[]; // full log, loaded lazily for replay
  eventsLoaded: boolean;
  connected: boolean;
  version: number;
  selection: Selection | null;
  focusSeq: number; // bumps to request the graph to focus selection
  lowPower: boolean;
  reducedMotion: boolean;
  /** Client receive time per signal seq, to animate only fresh flows. */
  signalTimes: Map<number, number>;
}

const prefersReduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const storedLow = (() => {
  try {
    return localStorage.getItem('synape.lowPower') === '1';
  } catch {
    return false;
  }
})();

let st: StoreState = {
  runId: null,
  live: null,
  cursor: null,
  replay: null,
  events: [],
  eventsLoaded: false,
  connected: false,
  version: 0,
  selection: null,
  focusSeq: 0,
  lowPower: storedLow,
  reducedMotion: prefersReduced,
  signalTimes: new Map(),
};
const subs = new Set<() => void>();
let raf = 0;
let unsubscribeStream: (() => void) | null = null;

function notify(immediate = false) {
  if (immediate) {
    st = { ...st, version: st.version + 1 };
    subs.forEach((f) => f());
    return;
  }
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    st = { ...st, version: st.version + 1 };
    subs.forEach((f) => f());
  });
}

export function useStore<T>(sel: (s: StoreState) => T): T {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => sel(st),
  );
}
export const getStore = () => st;

/** The state the UI should render: replay snapshot or live. */
export const viewState = (s: StoreState) => (s.cursor !== null ? s.replay : s.live);

export async function openRun(runId: string) {
  unsubscribeStream?.();
  st = { ...st, runId, live: null, cursor: null, replay: null, events: [], eventsLoaded: false, selection: null, signalTimes: new Map() };
  notify(true);
  const snapshot = await api.state(runId);
  if (st.runId !== runId) return;
  st.live = snapshot;
  notify(true);
  unsubscribeStream = streamRun(
    runId,
    snapshot.lastSeq,
    (e) => {
      if (st.runId !== runId || !st.live) return;
      const before = st.live.signals.length ? st.live.signals[st.live.signals.length - 1].seq : 0;
      applyEvent(st.live, e);
      const sigs = st.live.signals;
      for (let i = sigs.length - 1; i >= 0 && sigs[i].seq > before; i--) st.signalTimes.set(sigs[i].seq, performance.now());
      if (st.eventsLoaded) st.events.push(e);
      notify();
    },
    (c) => {
      st = { ...st, connected: c };
      notify();
    },
  );
}

export async function loadEvents() {
  if (!st.runId || st.eventsLoaded) return;
  const runId = st.runId;
  const evs = await api.events(runId);
  if (st.runId !== runId) return;
  // Merge with anything streamed meanwhile.
  const lastSeq = evs.length ? evs[evs.length - 1].seq : 0;
  st.events = evs.filter((e) => e.seq <= lastSeq);
  st.eventsLoaded = true;
  notify(true);
}

export async function setCursor(seq: number | null) {
  if (seq === null || (st.live && seq >= st.live.lastSeq)) {
    st = { ...st, cursor: null, replay: null };
    notify(true);
    return;
  }
  await loadEvents();
  // Moving forward continues folding the current replay state; moving back refolds from scratch.
  const forward = st.replay && st.cursor !== null && seq >= st.cursor;
  const replay = foldEvents(st.events, forward ? st.replay! : initialState(st.runId ?? ''), seq);
  st = { ...st, cursor: seq, replay };
  notify(true);
}

export function select(sel: Selection | null, focus = false) {
  st = { ...st, selection: sel, focusSeq: focus ? st.focusSeq + 1 : st.focusSeq };
  notify(true);
}

export function setLowPower(v: boolean) {
  try {
    localStorage.setItem('synape.lowPower', v ? '1' : '0');
  } catch {}
  st = { ...st, lowPower: v };
  notify(true);
}
