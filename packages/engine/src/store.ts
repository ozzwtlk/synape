import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyEvent, foldEvents, initialState, type EventBody, type EventEnvelope, type ModelStats, type RunState, type TaskCategory } from '@synape/core';

export interface AppendMeta {
  correlationId?: string;
  causationId?: string;
  /** Idempotency key: a second append with the same key is a no-op. */
  dedupeKey?: string;
}

export interface PerfRecord {
  modelId: string;
  category: TaskCategory;
  complexity: number;
  success: boolean;
  verified: boolean | null;
  tokens: number;
  durationMs: number;
  attempt: number;
  failureReason?: string;
  runId: string;
  taskId: string;
}

type Listener = (e: EventEnvelope) => void;

const SNAPSHOT_EVERY = 250;

/**
 * Durable, append-only event store with per-run projections.
 *
 * - `events` is the source of truth (seq is per-run, monotonic).
 * - `snapshots` hold periodic projected states to bound recovery time.
 * - Live projected state is kept in memory and updated by the same reducer
 *   the UI uses, so scheduler and UI can never disagree.
 */
export class EventStore {
  private db: DatabaseSync;
  private states = new Map<string, RunState>();
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<Listener>();
  private sinceSnapshot = new Map<string, number>();
  private perfCache: Map<string, ModelStats> | null = null;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, title TEXT, objective TEXT, workspace TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL, type TEXT NOT NULL, correlation_id TEXT, causation_id TEXT,
        dedupe_key TEXT, body TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(run_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_type ON events(run_id, type);
      CREATE TABLE IF NOT EXISTS snapshots (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS perf (
        id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT, category TEXT, complexity INTEGER,
        success INTEGER, verified INTEGER, tokens INTEGER, duration_ms INTEGER, attempt INTEGER,
        failure_reason TEXT, run_id TEXT, task_id TEXT, ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS perf_model ON perf(model_id, category);
    `);
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- events

  append(runId: string, body: EventBody, meta: AppendMeta = {}): EventEnvelope | null {
    if (meta.dedupeKey) {
      const dup = this.db.prepare('SELECT 1 FROM events WHERE run_id = ? AND dedupe_key = ?').get(runId, meta.dedupeKey);
      if (dup) return null;
    }
    const state = this.state(runId);
    const env: EventEnvelope = {
      seq: state.lastSeq + 1,
      id: randomUUID(),
      runId,
      ts: Date.now(),
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      body,
    };
    this.db
      .prepare('INSERT INTO events (run_id, seq, id, ts, type, correlation_id, causation_id, dedupe_key, body) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(runId, env.seq, env.id, env.ts, body.type, env.correlationId ?? null, env.causationId ?? null, meta.dedupeKey ?? null, JSON.stringify(body));
    applyEvent(state, env);
    if (body.type === 'run.created') {
      this.db
        .prepare('INSERT OR REPLACE INTO runs (id, title, objective, workspace, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(runId, body.title, body.objective, body.workspace, 'planning', env.ts, env.ts);
    } else if (body.type === 'run.status') {
      this.db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(body.status, env.ts, runId);
    }
    const n = (this.sinceSnapshot.get(runId) ?? 0) + 1;
    if (n >= SNAPSHOT_EVERY) {
      this.snapshot(runId);
      this.sinceSnapshot.set(runId, 0);
    } else this.sinceSnapshot.set(runId, n);
    for (const l of this.listeners.get(runId) ?? []) l(env);
    for (const l of this.globalListeners) l(env);
    return env;
  }

  /** Current projected state (loaded from snapshot + tail on first access). */
  state(runId: string): RunState {
    let s = this.states.get(runId);
    if (s) return s;
    const snap = this.db.prepare('SELECT seq, state FROM snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as { seq: number; state: string } | undefined;
    s = snap ? (JSON.parse(snap.state) as RunState) : initialState(runId);
    s = foldEvents(this.events(runId, s.lastSeq), s);
    this.states.set(runId, s);
    return s;
  }

  snapshot(runId: string) {
    const s = this.state(runId);
    this.db.prepare('INSERT OR REPLACE INTO snapshots (run_id, seq, state) VALUES (?,?,?)').run(runId, s.lastSeq, JSON.stringify(s));
  }

  events(runId: string, afterSeq = 0, limit = 1_000_000, types?: string[]): EventEnvelope[] {
    const rows = types?.length
      ? (this.db
          .prepare(`SELECT * FROM events WHERE run_id = ? AND seq > ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`)
          .all(runId, afterSeq, ...types, limit) as any[])
      : (this.db.prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(runId, afterSeq, limit) as any[]);
    return rows.map(rowToEnvelope);
  }

  agentLog(runId: string, agentId: string): EventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE run_id = ? AND type IN ('agent.output','tool.started','tool.finished','agent.status','usage','error')
         AND json_extract(body, '$.agentId') = ? ORDER BY seq`,
      )
      .all(runId, agentId) as any[];
    return rows.map(rowToEnvelope);
  }

  listRuns(): { id: string; title: string; objective: string; workspace: string; status: string; createdAt: number; updatedAt: number }[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      objective: r.objective,
      workspace: r.workspace,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Drop the in-memory projection (used by tests to prove recovery from disk). */
  evict(runId: string) {
    this.states.delete(runId);
  }

  subscribe(runId: string, l: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(l);
    return () => set!.delete(l);
  }

  subscribeAll(l: Listener): () => void {
    this.globalListeners.add(l);
    return () => this.globalListeners.delete(l);
  }

  // ----------------------------------------------------------- performance

  recordPerf(r: PerfRecord) {
    this.db
      .prepare(
        'INSERT INTO perf (model_id, category, complexity, success, verified, tokens, duration_ms, attempt, failure_reason, run_id, task_id, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(r.modelId, r.category, r.complexity, r.success ? 1 : 0, r.verified === null ? null : r.verified ? 1 : 0, r.tokens, r.durationMs, r.attempt, r.failureReason ?? null, r.runId, r.taskId, Date.now());
    this.perfCache = null;
  }

  perfStats(modelId: string, category: TaskCategory): ModelStats | undefined {
    if (!this.perfCache) {
      this.perfCache = new Map();
      const rows = this.db
        .prepare('SELECT model_id, category, SUM(success) s, COUNT(*) n, AVG(CASE WHEN success = 1 THEN tokens END) t, AVG(duration_ms) d FROM perf GROUP BY model_id, category')
        .all() as any[];
      for (const r of rows) this.perfCache.set(`${r.model_id}|${r.category}`, { successes: r.s, failures: r.n - r.s, meanTokens: r.t ?? undefined, meanDurationMs: r.d ?? undefined });
    }
    return this.perfCache.get(`${modelId}|${category}`);
  }

  perfTable() {
    return this.db
      .prepare('SELECT model_id modelId, category, COUNT(*) n, SUM(success) successes, AVG(tokens) meanTokens, AVG(duration_ms) meanDurationMs FROM perf GROUP BY model_id, category ORDER BY model_id')
      .all();
  }
}

function rowToEnvelope(r: any): EventEnvelope {
  return {
    seq: r.seq,
    id: r.id,
    runId: r.run_id,
    ts: r.ts,
    correlationId: r.correlation_id ?? undefined,
    causationId: r.causation_id ?? undefined,
    body: JSON.parse(r.body),
  };
}
