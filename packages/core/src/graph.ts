import type { RunState, Task, TaskStatus } from './types.ts';

export const TERMINAL_TASK: TaskStatus[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (t: Task) => TERMINAL_TASK.includes(t.status);

/** Would adding `deps` to `taskId` create a cycle? Returns the cycle path if so. */
export function findCycle(tasks: Record<string, Pick<Task, 'deps'>>, taskId: string, deps: string[]): string[] | null {
  const seen = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): boolean => {
    if (id === taskId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    stack.push(id);
    for (const d of tasks[id]?.deps ?? []) if (visit(d)) return true;
    stack.pop();
    return false;
  };
  for (const d of deps) {
    if (visit(d)) return [taskId, ...stack, taskId];
  }
  return null;
}

/** Topologically validate a batch of new tasks keyed locally. Throws on cycle. */
export function topoOrder<T extends { key: string; deps: string[] }>(items: T[]): T[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out: T[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (k: string, path: string[]) => {
    const st = state.get(k);
    if (st === 2) return;
    if (st === 1) throw new Error(`Dependency cycle: ${[...path, k].join(' → ')}`);
    const it = byKey.get(k);
    if (!it) return; // external dependency
    state.set(k, 1);
    for (const d of it.deps) visit(d, [...path, k]);
    state.set(k, 2);
    out.push(it);
  };
  for (const i of items) visit(i.key, []);
  return out;
}

/** A task is ready when every dependency completed. */
export function depsSatisfied(s: RunState, t: Task): 'yes' | 'no' | 'broken' {
  let ok = true;
  for (const d of t.deps) {
    const dep = s.tasks[d];
    if (!dep || dep.status === 'failed' || dep.status === 'cancelled') return 'broken';
    if (dep.status !== 'completed') ok = false;
  }
  return ok ? 'yes' : 'no';
}

/** All tasks transitively owned by `taskId` (children via parentTaskId). */
export function descendants(s: RunState, taskId: string): Task[] {
  const out: Task[] = [];
  const q = [taskId];
  while (q.length) {
    const id = q.shift()!;
    for (const t of Object.values(s.tasks)) {
      if (t.parentTaskId === id) {
        out.push(t);
        q.push(t.id);
      }
    }
  }
  return out;
}

export function children(s: RunState, taskId: string): Task[] {
  return Object.values(s.tasks).filter((t) => t.parentTaskId === taskId);
}

/** Normalized fingerprint for duplicate-work detection. */
export function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .sort()
    .join(' ');
}

/** Jaccard similarity of word sets. */
export function similarity(a: string, b: string): number {
  const A = new Set(fingerprint(a).split(' '));
  const B = new Set(fingerprint(b).split(' '));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function activeAgents(s: RunState) {
  return Object.values(s.agents).filter((a) => a.status === 'starting' || a.status === 'running');
}
