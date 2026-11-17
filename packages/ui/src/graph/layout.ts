import type { RunState, Task } from '@synape/core';

export type LayoutMode = 'orbit' | 'flow';
export interface Pt {
  x: number;
  y: number;
}

export const NODE_W = { hub: 250, work: 216, review: 168 };
export const NODE_H = { hub: 86, work: 70, review: 44 };

export const sizeOf = (t: Task) => (t.kind === 'review' ? 'review' : t.kind === 'plan' || t.kind === 'orchestrate' ? 'hub' : 'work');

/** Tasks visible given collapsed clusters. Reviews ride along with their target. */
export function visibleTasks(s: RunState, collapsed: Set<string>): Task[] {
  const hidden = new Set<string>();
  const all = Object.values(s.tasks);
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

/** Radial "orbital" hierarchy: orchestrators at the core, workers in rings. */
function orbit(tasks: Task[]): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const kids = childrenMap(tasks);
  const weight = new Map<string, number>();
  const w = (t: Task): number => {
    const c = kids.get(t.id) ?? [];
    const v = Math.max(1, c.reduce((a, k) => a + w(k), 0));
    weight.set(t.id, v);
    return v;
  };
  const roots = kids.get(undefined) ?? [];
  roots.forEach(w);
  const depthCount = new Map<number, number>();
  const countDepth = (t: Task, d: number) => {
    depthCount.set(d, (depthCount.get(d) ?? 0) + 1);
    for (const k of kids.get(t.id) ?? []) countDepth(k, d + 1);
  };
  roots.forEach((r) => countDepth(r, 0));
  const radius = (d: number) => (d === 0 ? 0 : Math.max(400 * d, ((depthCount.get(d) ?? 1) * 290) / (2 * Math.PI)));

  const place = (t: Task, d: number, a0: number, a1: number) => {
    const mid = (a0 + a1) / 2;
    const r = radius(d);
    pos.set(t.id, { x: Math.cos(mid) * r, y: Math.sin(mid) * r });
    const c = kids.get(t.id) ?? [];
    const total = c.reduce((a, k) => a + weight.get(k.id)!, 0) || 1;
    // Children of non-root clusters fan out within (slightly widened) parent wedge.
    const span = d === 0 ? a1 - a0 : Math.min(a1 - a0 + 0.35, Math.PI * 1.2);
    let a = d === 0 ? a0 : mid - span / 2;
    for (const k of c) {
      const da = (span * weight.get(k.id)!) / total;
      place(k, d + 1, a, a + da);
      a += da;
    }
  };
  const rootSpan = (2 * Math.PI) / Math.max(1, roots.length);
  roots.forEach((r, i) => place(r, 0, -Math.PI / 2 + i * rootSpan, -Math.PI / 2 + (i + 1) * rootSpan));
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
    const heights = list.map((t) => 112 + Math.min(2, reviewCount.get(t.id) ?? 0) * 58);
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
    if (mode === 'flow') pos.set(t.id, { x: p.x + 24 + i * 16, y: p.y + 80 + i * 54 });
    else {
      // Satellites on an outer orbit, fanned along the tangent.
      const len = Math.hypot(p.x, p.y) || 1;
      const ux = p.x / len;
      const uy = p.y / len;
      const off = (i - 0.5) * 70;
      pos.set(t.id, { x: p.x + ux * 190 - uy * off, y: p.y + uy * 150 + ux * off });
    }
  }
}

export function layout(tasks: Task[], mode: LayoutMode): Map<string, Pt> {
  const pos = mode === 'orbit' ? orbit(tasks) : flow(tasks);
  // Convert centers to top-left anchors.
  const out = new Map<string, Pt>();
  for (const t of tasks) {
    const p = pos.get(t.id) ?? { x: 0, y: 0 };
    const k = sizeOf(t);
    out.set(t.id, mode === 'orbit' ? { x: p.x - NODE_W[k] / 2, y: p.y - NODE_H[k] / 2 } : p);
  }
  return out;
}
