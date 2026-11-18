import type { RunState, Task } from '@synape/core';

export type LayoutMode = 'orbit' | 'flow';
export interface Pt {
  x: number;
  y: number;
}

/** Orb diameter by role: orchestrators biggest, workers smaller, reviews smaller still. */
export const orbSize = (t: Task) => (t.kind === 'plan' ? 124 : t.kind === 'orchestrate' ? 94 : t.kind === 'synthesize' ? 66 : t.kind === 'review' ? 34 : 60);
export const COMPUTE_D = 22;
export const computeId = (taskId: string, program: string) => `cmp:${taskId}:${program}`;
const programsOf = (t: Task) => Object.keys(t.computes ?? {});

/** Tasks visible given collapsed clusters. Reviews ride along with their target. */
/** Tasks to draw. Archived ones (finished earlier missions) only with `history`. */
export function visibleTasks(s: RunState, collapsed: Set<string>, history = false): Task[] {
  const hidden = new Set<string>();
  const all = Object.values(s.tasks).filter((t) => history || !t.archived);
  const kids = new Map<string, Task[]>();
  for (const t of all) if (t.parentTaskId) kids.set(t.parentTaskId, [...(kids.get(t.parentTaskId) ?? []), t]);
  const hide = (id: string) => {
    for (const k of kids.get(id) ?? []) {
      hidden.add(k.id);
      hide(k.id);
    }
  };
  for (const c of collapsed) hide(c);
  return all.filter((t) => !hidden.has(t.id) && !(t.reviewOf && hidden.has(t.reviewOf)));
}

function childrenMap(tasks: Task[]) {
  const ids = new Set(tasks.map((t) => t.id));
  const m = new Map<string | undefined, Task[]>();
  for (const t of tasks) {
    if (t.kind === 'review') continue;
    const p = t.parentTaskId && ids.has(t.parentTaskId) ? t.parentTaskId : undefined;
    m.set(p, [...(m.get(p) ?? []), t]);
  }
  // Order siblings: dependency order, synthesis last.
  for (const [, list] of m) {
    const order = new Map<string, number>();
    const lvl = (t: Task, seen = new Set<string>()): number => {
      if (order.has(t.id)) return order.get(t.id)!;
      if (seen.has(t.id)) return 0;
      seen.add(t.id);
      const sib = t.deps.map((d) => list.find((x) => x.id === d)).filter(Boolean) as Task[];
      const v = sib.length ? Math.max(...sib.map((x) => lvl(x, seen))) + 1 : 0;
      order.set(t.id, v);
      return v;
    };
    list.sort((a, b) => (a.kind === 'synthesize' ? 1 : 0) - (b.kind === 'synthesize' ? 1 : 0) || lvl(a) - lvl(b) || a.createdAt - b.createdAt);
  }
  return m;
}

/**
 * Nested orbital systems: every orchestrator is a "sun" whose delegated tasks
 * orbit it on a local ring; sub-orchestrators carry their own systems. The
 * hierarchy is therefore readable from spatial grouping alone.
 */
function orbit(tasks: Task[]): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const kids = childrenMap(tasks);
  const reviewsOf = new Map<string, number>();
  for (const t of tasks) if (t.reviewOf) reviewsOf.set(t.reviewOf, (reviewsOf.get(t.reviewOf) ?? 0) + 1);
  const LEAF = 100; // radius a leaf orb + its label needs
  const radiusOf = new Map<string, number>(); // extent of a node's whole system
  const ringOf = new Map<string, number>(); // radius of its children's orbit
  const measure = (t: Task): number => {
    const c = kids.get(t.id) ?? [];
    const own = LEAF + (reviewsOf.get(t.id) ? 30 : 0) + (programsOf(t).length ? 34 : 0);
    if (!c.length) {
      radiusOf.set(t.id, own);
      return own;
    }
    const sizes = c.map(measure);
    const circumference = sizes.reduce((a, r) => a + 2 * r + 16, 0);
    const ring = Math.max(own + Math.max(...sizes) * 0.8, circumference / (2 * Math.PI));
    ringOf.set(t.id, ring);
    const r = ring + Math.max(...sizes);
    radiusOf.set(t.id, r);
    return r;
  };
  const GAP = 0.35; // radians kept free toward the parent's incoming edge
  const place = (t: Task, x: number, y: number, outward: number | null) => {
    pos.set(t.id, { x, y });
    const c = kids.get(t.id) ?? [];
    if (!c.length) return;
    const ring = ringOf.get(t.id)! * (outward === null ? 1 : (2 * Math.PI) / (2 * Math.PI - 2 * GAP));
    orbitRings.set(t.id, { x, y, r: ring });
    const weights = c.map((k) => 2 * radiusOf.get(k.id)! + 16);
    const total = weights.reduce((a, b) => a + b, 0);
    const span = outward === null ? 2 * Math.PI : 2 * Math.PI - 2 * GAP;
    let a = outward === null ? -Math.PI / 2 : outward - span / 2;
    c.forEach((k, i) => {
      const share = (span * weights[i]) / total;
      const mid = a + share / 2;
      place(k, x + Math.cos(mid) * ring, y + Math.sin(mid) * ring, mid);
      a += share;
    });
  };
  const roots = kids.get(undefined) ?? [];
  let ox = 0;
  for (const r of roots) {
    const rad = measure(r);
    place(r, ox + rad, 0, null);
    ox += 2 * rad + 80;
  }
  placeReviews(tasks, pos, 'orbit');
  return pos;
}

/** Layered left→right flow: hierarchy and dependencies read in time order. */
function flow(tasks: Task[]): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const lv = (t: Task, seen = new Set<string>()): number => {
    if (level.has(t.id)) return level.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    let v = 0;
    const p = t.parentTaskId ? byId.get(t.parentTaskId) : undefined;
    if (p) v = lv(p, seen) + 1;
    for (const d of t.deps) {
      const dt = byId.get(d);
      if (dt && dt.kind !== 'review') v = Math.max(v, lv(dt, seen) + 1);
    }
    level.set(t.id, v);
    return v;
  };
  const main = tasks.filter((t) => t.kind !== 'review');
  main.forEach((t) => lv(t));
  const cols = new Map<number, Task[]>();
  // Keep clusters together: order by DFS of hierarchy.
  const kids = childrenMap(tasks);
  const dfsOrder: string[] = [];
  const dfs = (t: Task) => {
    dfsOrder.push(t.id);
    for (const k of kids.get(t.id) ?? []) dfs(k);
  };
  (kids.get(undefined) ?? []).forEach(dfs);
  const rank = new Map(dfsOrder.map((id, i) => [id, i]));
  for (const t of main) cols.set(level.get(t.id)!, [...(cols.get(level.get(t.id)!) ?? []), t]);
  const reviewCount = new Map<string, number>();
  for (const t of tasks) if (t.reviewOf) reviewCount.set(t.reviewOf, (reviewCount.get(t.reviewOf) ?? 0) + 1);
  for (const [c, list] of cols) {
    list.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const heights = list.map((t) => 150 + (programsOf(t).length ? 40 : 0));
    const total = heights.reduce((a, b) => a + b, 0);
    let y = -total / 2;
    list.forEach((t, i) => {
      pos.set(t.id, { x: c * 330, y });
      y += heights[i];
    });
  }
  placeReviews(tasks, pos, 'flow');
  return pos;
}

function placeReviews(tasks: Task[], pos: Map<string, Pt>, mode: LayoutMode) {
  const seen = new Map<string, number>();
  for (const t of tasks) {
    if (!t.reviewOf) continue;
    const p = pos.get(t.reviewOf);
    if (!p) continue;
    const i = seen.get(t.reviewOf) ?? 0;
    seen.set(t.reviewOf, i + 1);
    if (mode === 'flow') pos.set(t.id, { x: p.x + 92 + i * 30, y: p.y - 18 + i * 62 });
    else {
      // Satellites just outside their target, away from its orchestrator, stacked.
      const parent = tasks.find((x) => x.id === tasks.find((y) => y.id === t.reviewOf)?.parentTaskId);
      const pp = parent ? pos.get(parent.id) : undefined;
      const dx = pp ? p.x - pp.x : p.x;
      const dy = pp ? p.y - pp.y : p.y;
      // Outward from the orchestrator, but never straight down onto the target's label.
      let a = Math.atan2(dy, dx);
      const fromDown = Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2));
      if (Math.abs(fromDown) < 1.15) a = Math.PI / 2 + (fromDown < 0 ? -1.15 : 1.15);
      const R = 84 + i * 44;
      pos.set(t.id, { x: p.x + Math.cos(a) * R, y: p.y + Math.sin(a) * R });
    }
  }
}

/** Orbit tracks (centre + radius) of each orchestrator, filled by the orbit layout. */
export const orbitRings = new Map<string, { x: number; y: number; r: number }>();

/**
 * Computation satellites hug their task on a tight arc, to the side of the
 * direction away from the parent (reviews take the outward direction).
 */
function placeComputes(tasks: Task[], pos: Map<string, Pt>, mode: LayoutMode) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    const progs = programsOf(t);
    const p = pos.get(t.id);
    if (!progs.length || !p) continue;
    const R = orbSize(t) / 2 + 30;
    const step = 56 / R; // ~56px between satellite centres, room for labels
    // Keep clear of the label (below), the incoming edge (toward the parent)
    // and review satellites (outward): pick the emptiest direction.
    const pp = t.parentTaskId && byId.has(t.parentTaskId) ? pos.get(t.parentTaskId) : undefined;
    const out = mode === 'orbit' && pp ? Math.atan2(p.y - pp.y, p.x - pp.x) : 0;
    const reviewDirs = tasks.filter((r) => r.reviewOf === t.id && pos.has(r.id)).map((r) => Math.atan2(pos.get(r.id)!.y - p.y, pos.get(r.id)!.x - p.x));
    const avoid = [Math.PI / 2, Math.PI / 2 - 0.5, Math.PI / 2 + 0.5, ...(pp ? [out + Math.PI] : []), ...reviewDirs, ...(mode === 'orbit' && pp ? [out] : [])];
    const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const half = ((progs.length - 1) / 2) * step;
    let base = -Math.PI / 2;
    let bestScore = -1;
    for (let k = 0; k < 24; k++) {
      const a = -Math.PI + (k * Math.PI) / 12;
      // Score the whole arc by its closest approach to anything to avoid.
      const score = Math.min(...avoid.map((v) => Math.max(0, gap(a, v) - half)));
      if (score > bestScore + 1e-6) (bestScore = score), (base = a);
    }
    progs.forEach((prog, i) => {
      const a = base + (i - (progs.length - 1) / 2) * step;
      pos.set(computeId(t.id, prog), { x: p.x + Math.cos(a) * R, y: p.y + Math.sin(a) * R });
    });
  }
}

/** Top-left anchors for every task orb and computation satellite. */
export function layout(tasks: Task[], mode: LayoutMode): Map<string, Pt> {
  orbitRings.clear();
  const pos = mode === 'orbit' ? orbit(tasks) : flow(tasks);
  placeComputes(tasks, pos, mode);
  const out = new Map<string, Pt>();
  for (const t of tasks) {
    const p = pos.get(t.id) ?? { x: 0, y: 0 };
    const d = orbSize(t);
    out.set(t.id, { x: p.x - d / 2, y: p.y - d / 2 });
    for (const prog of programsOf(t)) {
      const q = pos.get(computeId(t.id, prog));
      if (q) out.set(computeId(t.id, prog), { x: q.x - COMPUTE_D / 2, y: q.y - COMPUTE_D / 2 });
    }
  }
  return out;
}
