import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_MODELS,
  DEFAULT_CONFIG,
  activeAgents,
  billableTokens,
  depsSatisfied,
  descendants,
  findCycle,
  isTerminal,
  permissionRank,
  route,
  similarity,
  topoOrder,
  type AgentRole,
  type EventBody,
  type ModelProfile,
  type PermissionLevel,
  type RoutingDecision,
  type RunConfig,
  type RunState,
  type Task,
  type TaskSpec,
} from '@synape/core';
import type { EventStore } from './store.ts';
import { retryAfterMs, type AdapterEvent, type ErrorClass, type ProviderAdapter, type ProviderInfo } from './adapters/types.ts';
import {
  PLAN_SCHEMA,
  REPLAN_SCHEMA,
  REVIEW_SCHEMA,
  SYSTEM_PLANNER,
  SYSTEM_REVIEWER,
  SYSTEM_WORKER,
  extractDelegation,
  extractSummary,
  parseStructured,
  planPrompt,
  replanPrompt,
  reviewPrompt,
  synthesisPrompt,
  workPrompt,
  type Plan,
  type PlannedTask,
} from './prompts.ts';
import { Worktrees, repoInfo } from './workspace.ts';
import { execText } from './adapters/proc.ts';

export interface EngineOptions {
  store: EventStore;
  adapters: ProviderAdapter[];
  dataDir: string;
  models?: Omit<ModelProfile, 'available'>[];
  log?: (msg: string) => void;
}

interface RunningAgent {
  runId: string;
  agentId: string;
  taskId: string;
  provider: string;
  abort: AbortController;
}

/** Agents that count toward a task's retry budget: since the last reopen, excluding interruptions. */
const countedAttempts = (s: RunState, t: Task) => t.agentIds.slice(t.attemptFloor ?? 0).filter((x) => s.agents[x]?.status !== 'interrupted').length;

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export class Engine {
  readonly store: EventStore;
  readonly dataDir: string;
  private adapters = new Map<string, ProviderAdapter>();
  providers = new Map<string, ProviderInfo>();
  models: ModelProfile[] = [];
  private running = new Map<string, RunningAgent>();
  private tickQueued = new Set<string>();
  private resumeTimers = new Map<string, NodeJS.Timeout>();
  private worktrees: Worktrees;
  private repoCache = new Map<string, Awaited<ReturnType<typeof repoInfo>>>();
  private shuttingDown = false;
  private log: (m: string) => void;
  private catalog: Omit<ModelProfile, 'available'>[];

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.dataDir = opts.dataDir;
    for (const a of opts.adapters) this.adapters.set(a.id, a);
    this.worktrees = new Worktrees(join(opts.dataDir, 'worktrees'));
    this.log = opts.log ?? (() => {});
    this.catalog = opts.models ?? BUILTIN_MODELS;
  }

  // ================================================================ setup

  async init() {
    await this.detectProviders();
    this.recover();
  }

  async detectProviders() {
    const infos = await Promise.all([...this.adapters.values()].map((a) => a.detect().catch((e): ProviderInfo => ({ id: a.id, label: a.id, available: false, reason: String(e), billing: 'unknown' }))));
    for (const i of infos) this.providers.set(i.id, i);
    this.models = this.catalog.map((m) => {
      const p = this.providers.get(m.provider);
      return { ...m, available: !!p?.available, unavailableReason: p?.available ? undefined : (p?.reason ?? 'no adapter') };
    });
    return infos;
  }

  /** Resume runs that were active when the process stopped. */
  recover() {
    for (const r of this.store.listRuns()) {
      if (!['planning', 'running', 'paused'].includes(r.status)) continue;
      const s = this.store.state(r.id);
      const recovered: string[] = [];
      for (const a of Object.values(s.agents)) {
        if (a.status !== 'starting' && a.status !== 'running') continue;
        this.killStale(a.pid);
        this.emit(r.id, { type: 'agent.status', agentId: a.id, status: 'interrupted', reason: 'process stopped before the agent finished' });
        const t = s.tasks[a.taskId];
        if (t && t.status === 'running') {
          this.emit(r.id, { type: 'task.status', taskId: t.id, status: 'ready', reason: a.sessionId ? 'recovered: will resume agent session' : 'recovered: will re-run' });
          recovered.push(t.id);
        }
      }
      this.emit(r.id, { type: 'recovery', detail: `Recovered run after restart; ${recovered.length} task(s) re-queued`, taskIds: recovered });
      if (r.status !== 'paused') this.scheduleTick(r.id);
      else if (s.run.resumeAt) this.armAutoResume(r.id, s.run.resumeAt);
    }
  }

  private killStale(pid?: number) {
    if (!pid) return;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (/claude|codex/.test(cmd)) process.kill(-pid, 'SIGTERM');
    } catch {}
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const t of this.resumeTimers.values()) clearTimeout(t);
    this.resumeTimers.clear();
    for (const r of this.running.values()) r.abort.abort();
    const deadline = Date.now() + 8000;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  // ================================================================ events

  emit(runId: string, body: EventBody, meta: { correlationId?: string; causationId?: string; dedupeKey?: string } = {}) {
    return this.store.append(runId, body, meta);
  }

  state(runId: string): RunState {
    return this.store.state(runId);
  }

  private scheduleTick(runId: string) {
    if (this.tickQueued.has(runId)) return;
    this.tickQueued.add(runId);
    setImmediate(() => {
      this.tickQueued.delete(runId);
      try {
        this.tick(runId);
      } catch (e) {
        this.log(`tick error: ${(e as Error).stack}`);
        this.emit(runId, { type: 'error', message: `scheduler: ${(e as Error).message}`, recoverable: true });
      }
    });
  }

  artifactDir(runId: string, taskId: string) {
    const d = join(this.dataDir, 'artifacts', runId, taskId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private writeArtifact(runId: string, taskId: string, agentId: string | undefined, kind: 'report' | 'diff' | 'plan' | 'verdict' | 'data', name: string, title: string, content: string, summary?: string) {
    const path = join(this.artifactDir(runId, taskId), name);
    writeFileSync(path, content);
    const artId = id('art');
    this.emit(runId, { type: 'artifact.created', id: artId, taskId, agentId, kind, title, path, bytes: Buffer.byteLength(content), summary }, { dedupeKey: `art:${agentId ?? taskId}:${name}` });
    return { id: artId, path };
  }

  // ================================================================ runs

  createRun(input: { objective: string; workspace: string; title?: string; config?: Partial<RunConfig> }): string {
    const runId = id('run');
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      ...input.config,
      limits: { ...DEFAULT_CONFIG.limits, ...input.config?.limits },
      budgets: { ...DEFAULT_CONFIG.budgets, ...input.config?.budgets },
    };
    const title = input.title ?? input.objective.split('\n')[0].slice(0, 80);
    this.emit(runId, { type: 'run.created', runId, title, objective: input.objective, workspace: input.workspace, config });
    this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'user', text: input.objective });
    const len = input.objective.length;
    this.createTask(runId, {
      title: 'Plan',
      objective: input.objective,
      kind: 'plan',
      category: 'planning',
      complexity: len > 1500 ? 4 : len > 400 ? 3 : 2,
      criticality: 2,
      acceptance: ['A dependency graph of self-contained tasks that covers the objective'],
      verification: 'none',
      permission: 'read',
    }, { depth: 0, deps: [] });
    this.emit(runId, { type: 'run.status', status: 'running' });
    this.scheduleTick(runId);
    return runId;
  }

  pause(runId: string) {
    this.clearAutoResume(runId);
    this.emit(runId, { type: 'run.status', status: 'paused', reason: 'paused by user; running agents finish, no new agents start' });
  }

  resume(runId: string, reason = 'resumed by user') {
    const s = this.state(runId);
    if (s.run.status !== 'paused' && s.run.status !== 'failed') return;
    this.clearAutoResume(runId);
    if (s.run.status === 'failed') this.reopenFailed(runId);
    this.emit(runId, { type: 'run.status', status: 'running', reason });
    this.scheduleTick(runId);
  }

  /**
   * Resuming a failed run: give failed tasks a fresh retry budget. Tasks that
   * had delegated go back to waiting on their children; everything else re-queues.
   */
  private reopenFailed(runId: string) {
    const s = this.state(runId);
    const reopened: string[] = [];
    for (const t of Object.values(s.tasks)) {
      if (t.status !== 'failed') continue;
      // A review whose target already settled (e.g. completed unverified) stays as is.
      if (t.kind === 'review' && t.reviewOf && s.tasks[t.reviewOf]?.status !== 'awaiting_review' && s.tasks[t.reviewOf]?.status !== 'failed') continue;
      const delegated = Object.values(s.tasks).some((k) => k.parentTaskId === t.id);
      this.emit(runId, { type: 'task.reopened', taskId: t.id, status: delegated ? 'delegated' : 'pending', reason: 'reopened: run resumed after failure' });
      reopened.push(t.id);
    }
    this.emit(runId, { type: 'recovery', detail: `Run resumed; ${reopened.length} failed task(s) reopened with a fresh retry budget`, taskIds: reopened });
  }

  private armAutoResume(runId: string, at: number) {
    this.clearAutoResume(runId);
    // Timers can't exceed ~24.8 days; usage windows are far shorter.
    const t = setTimeout(() => {
      this.resumeTimers.delete(runId);
      if (this.state(runId).run.status === 'paused') this.resume(runId, 'usage limit reset: auto-resumed');
    }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
    t.unref?.();
    this.resumeTimers.set(runId, t);
  }

  private clearAutoResume(runId: string) {
    const t = this.resumeTimers.get(runId);
    if (t) clearTimeout(t);
    this.resumeTimers.delete(runId);
  }

  cancelRun(runId: string) {
    const s = this.state(runId);
    for (const t of Object.values(s.tasks)) if (!isTerminal(t)) this.cancelTask(runId, t.id, 'run cancelled', false);
    this.emit(runId, { type: 'run.status', status: 'cancelled', reason: 'cancelled by user' });
  }

  /** Cancel a task and everything beneath it. */
  cancelTask(runId: string, taskId: string, reason = 'cancelled by user', tick = true) {
    const s = this.state(runId);
    const root = s.tasks[taskId];
    if (!root) return;
    for (const t of [root, ...descendants(s, taskId)]) {
      if (isTerminal(t)) continue;
      for (const aid of t.agentIds) {
        const r = this.running.get(aid);
        if (r) r.abort.abort();
      }
      this.emit(runId, { type: 'task.status', taskId: t.id, status: 'cancelled', reason });
    }
    // Reviews of a cancelled task are moot.
    for (const t of Object.values(s.tasks)) if (t.reviewOf === taskId && !isTerminal(t)) this.cancelTask(runId, t.id, 'reviewed task cancelled', false);
    if (tick) this.scheduleTick(runId);
  }

  retryTask(runId: string, taskId: string) {
    const t = this.state(runId).tasks[taskId];
    if (!t || !['failed', 'cancelled', 'completed', 'blocked'].includes(t.status)) return;
    this.emit(runId, { type: 'task.status', taskId, status: 'ready', reason: 'retry requested by user' });
    const s = this.state(runId);
    if (['completed', 'failed'].includes(s.run.status)) this.emit(runId, { type: 'run.status', status: 'running', reason: 'task retried' });
    this.scheduleTick(runId);
  }

  resolveApproval(runId: string, approvalId: string, approved: boolean, note?: string) {
    const s = this.state(runId);
    const ap = s.approvals[approvalId];
    if (!ap || ap.status !== 'pending') return;
    this.emit(runId, { type: 'approval.resolved', approvalId, approved, note });
    if (ap.kind === 'permission' && ap.taskId) {
      const t = s.tasks[ap.taskId];
      if (t?.status === 'blocked') this.emit(runId, { type: 'task.status', taskId: t.id, status: 'ready', reason: approved ? 'permission approved' : `permission denied; running at ceiling "${s.run.config.permissionCeiling}"` });
    } else if (ap.kind === 'budget') {
      if (approved) {
        const c = structuredClone(s.run.config);
        if (c.budgets.maxTokens) c.budgets.maxTokens = Math.round(c.budgets.maxTokens * 1.5);
        this.emit(runId, { type: 'run.config', config: c });
        this.emit(runId, { type: 'run.status', status: 'running', reason: 'budget raised by user' });
      }
    } else if (ap.kind === 'git-commit' || ap.kind === 'git-push' || ap.kind === 'pull-request') {
      if (approved) void this.performGitAction(runId, ap.kind, ap.payload as any);
    } else if (ap.kind === 'delegation' && ap.taskId) {
      const t = s.tasks[ap.taskId];
      if (t?.status === 'blocked') this.emit(runId, { type: 'task.status', taskId: t.id, status: 'ready', reason: approved ? 'approved' : 'denied' });
    }
    this.scheduleTick(runId);
  }

  // ================================================================ tasks

  private createTask(
    runId: string,
    spec: TaskSpec,
    rel: { parentTaskId?: string; createdBy?: string; depth: number; deps: string[]; reviewOf?: string },
    dedupeKey?: string,
  ): string | null {
    const s = this.state(runId);
    const lim = s.run.config.limits;
    const count = Object.keys(s.tasks).length;
    const structural = spec.kind === 'review' || spec.kind === 'synthesize' || spec.kind === 'plan';
    if (!structural && count >= lim.maxTasks) {
      this.emit(runId, { type: 'limit.hit', limit: 'maxTasks', detail: `Refused task "${spec.title}": run already has ${count} tasks (max ${lim.maxTasks})` });
      return null;
    }
    if (!structural) {
      // Duplicate-work prevention: near-identical live objective in the same run.
      for (const t of Object.values(s.tasks)) {
        if (t.kind === 'review' || t.kind === 'synthesize' || t.kind === 'plan' || t.status === 'cancelled' || t.id === rel.parentTaskId) continue;
        if (similarity(t.objective, spec.objective) > 0.85) {
          this.emit(runId, { type: 'duplicate.rejected', title: spec.title, existingTaskId: t.id });
          return t.id;
        }
      }
    }
    const deps = rel.deps.filter((d) => s.tasks[d]);
    const taskId = id('task');
    if (findCycle(s.tasks, taskId, deps)) throw new Error(`cycle creating ${spec.title}`);
    const env = this.emit(runId, { type: 'task.created', taskId, ...spec, ...rel, deps }, { dedupeKey });
    return env ? taskId : null;
  }

  /** Turn a validated plan into tasks beneath `parent`, plus a fan-in synthesis. */
  private materialize(runId: string, parent: Task, agentId: string, planned: PlannedTask[], opts: { existing?: boolean } = {}): string[] {
    const s = this.state(runId);
    const lim = s.run.config.limits;
    const items = planned.map((p) => ({ ...p, key: String(p.key), deps: (p.deps ?? []).map(String) }));
    const ordered = topoOrder(items); // throws on cycles
    const keyToId = new Map<string, string>();
    const created: string[] = [];
    const depth = parent.depth + 1;
    for (const p of ordered) {
      const deps = p.deps.map((d) => keyToId.get(d) ?? (opts.existing && s.tasks[d] ? d : undefined)).filter((x): x is string => !!x);
      const kind = p.kind === 'orchestrate' && depth < lim.maxDepth ? 'orchestrate' : 'work';
      if (p.kind === 'orchestrate' && kind === 'work') this.emit(runId, { type: 'limit.hit', limit: 'maxDepth', detail: `"${p.title}" requested orchestration at depth ${depth}; downgraded to a worker task`, taskId: parent.id });
      const perm = (['read', 'write', 'execute', 'network'] as const).includes(p.permission as any) ? p.permission : 'read';
      const tid = this.createTask(
        runId,
        {
          title: String(p.title).slice(0, 80),
          objective: String(p.objective),
          kind,
          category: (['extraction', 'analysis', 'coding', 'reasoning', 'writing', 'research'] as const).includes(p.category as any) ? p.category : 'analysis',
          complexity: Math.min(5, Math.max(1, Math.round(Number(p.complexity) || 3))),
          criticality: Math.min(3, Math.max(1, Math.round(Number(p.criticality) || 2))),
          acceptance: (p.acceptance ?? []).map(String).slice(0, 10),
          verification: (['none', 'review', 'crosscheck'] as const).includes(p.verification as any) ? p.verification : 'review',
          permission: perm,
          scope: (p.scope ?? []).map(String).slice(0, 20),
        },
        { parentTaskId: parent.id, createdBy: agentId, depth, deps },
        `plan:${agentId}:${p.key}`,
      );
      if (tid) {
        keyToId.set(p.key, tid);
        created.push(tid);
      }
    }
    if (!created.length) return created;
    // Fan-in: latest synthesis for this parent depends on all children.
    const s2 = this.state(runId);
    const synths = Object.values(s2.tasks).filter((t) => t.parentTaskId === parent.id && t.kind === 'synthesize');
    const live = synths.find((t) => t.status === 'pending' || t.status === 'ready');
    if (live) {
      this.emit(runId, { type: 'task.deps', taskId: live.id, deps: [...new Set([...live.deps, ...created])] });
    } else {
      const prev = synths.filter((t) => t.status === 'completed').at(-1);
      this.createTask(
        runId,
        {
          title: parent.parentTaskId ? `Synthesize: ${parent.title}`.slice(0, 80) : synths.length ? `Final synthesis (rev ${synths.length + 1})` : 'Final synthesis',
          objective: parent.objective,
          kind: 'synthesize',
          category: 'writing',
          complexity: Math.min(4, Math.max(2, ...planned.map((p) => Number(p.complexity) || 2))),
          criticality: parent.criticality,
          acceptance: ['Faithfully combines child results', 'Separates verified from unverified findings', 'Preserves disagreements and open questions'],
          verification: 'none',
          permission: 'read',
        },
        { parentTaskId: parent.id, createdBy: agentId, depth, deps: prev ? [prev.id, ...created] : created },
        `synth:${agentId}`,
      );
    }
    if (parent.status !== 'delegated') this.emit(runId, { type: 'task.status', taskId: parent.id, status: 'delegated', reason: `delegated ${created.length} task(s)` });
    return created;
  }

  // ================================================================ scheduler

  private tick(runId: string) {
    const s = this.state(runId);
    const run = s.run;
    if (!['running', 'planning'].includes(run.status)) return;
    const lim = run.config.limits;
    const seqAtStart = s.lastSeq;
    // Structural changes below can unblock more work: run again until stable.
    const settle = () => {
      if (this.state(runId).lastSeq !== seqAtStart) this.scheduleTick(runId);
    };

    // 1. Dependency resolution.
    for (const t of Object.values(s.tasks)) {
      if (t.status !== 'pending') continue;
      if (t.kind === 'synthesize') {
        if (t.deps.every((d) => !s.tasks[d] || isTerminal(s.tasks[d]))) this.emit(runId, { type: 'task.status', taskId: t.id, status: 'ready' });
        continue;
      }
      const ds = depsSatisfied(s, t);
      if (ds === 'yes') this.emit(runId, { type: 'task.status', taskId: t.id, status: 'ready' });
      else if (ds === 'broken') {
        const bad = t.deps.map((d) => s.tasks[d]).find((d) => !d || d.status === 'failed' || d.status === 'cancelled');
        this.emit(runId, { type: 'task.status', taskId: t.id, status: bad?.status === 'cancelled' ? 'cancelled' : 'failed', reason: `dependency "${bad?.title ?? '?'}" ${bad?.status ?? 'missing'}` });
      }
    }

    // 2. Delegated tasks complete when their latest synthesis does.
    for (const t of Object.values(s.tasks)) {
      if (t.status !== 'delegated') continue;
      const kids = Object.values(s.tasks).filter((k) => k.parentTaskId === t.id);
      if (kids.some((k) => !isTerminal(k))) continue;
      const synth = kids.filter((k) => k.kind === 'synthesize').at(-1);
      if (!synth) continue;
      if (synth.status === 'completed') {
        const allVerified = kids.filter((k) => k.kind === 'work' || k.kind === 'orchestrate').every((k) => k.verified || k.verification === 'none');
        this.emit(runId, { type: 'task.result', taskId: t.id, summary: synth.resultSummary ?? '', verified: allVerified });
        this.emit(runId, { type: 'task.status', taskId: t.id, status: 'completed', reason: 'all delegated work settled' });
      } else this.emit(runId, { type: 'task.status', taskId: t.id, status: 'failed', reason: `synthesis ${synth.status}` });
    }
    settle();

    // 3. Run completion.
    const root = run.rootTaskId ? s.tasks[run.rootTaskId] : undefined;
    if (root && isTerminal(root) && !Object.values(s.tasks).some((t) => !isTerminal(t))) {
      const status = root.status === 'completed' ? 'completed' : root.status === 'cancelled' ? 'cancelled' : 'failed';
      if (run.status !== status) {
        if (status === 'completed') {
          const final = run.finalArtifactId ? s.artifacts[run.finalArtifactId] : undefined;
          this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'orchestrator', text: `Run complete.\n\n${root.resultSummary ?? ''}${final ? `\n\nFull report: ${final.path}` : ''}`, refs: [root.id] });
        }
        this.emit(runId, { type: 'run.status', status, reason: root.statusReason });
      }
      return;
    }

    // 4. Budgets.
    const used = billableTokens(s.totals);
    if (run.config.budgets.maxTokens && used > run.config.budgets.maxTokens) {
      this.emit(runId, { type: 'limit.hit', limit: 'budget.maxTokens', detail: `${used} tokens used of ${run.config.budgets.maxTokens}` });
      this.emit(runId, { type: 'run.status', status: 'paused', reason: 'token budget exhausted' });
      this.emit(runId, { type: 'approval.requested', id: id('appr'), kind: 'budget', description: `Token budget exhausted (${used.toLocaleString()} / ${run.config.budgets.maxTokens.toLocaleString()}). Approve to raise it by 50% and continue.` }, { dedupeKey: `budget:${run.config.budgets.maxTokens}` });
      return;
    }
    const api = s.usageByProvider;
    const apiUsd = Object.values(api).filter((u) => u.costBasis === 'api-billed').reduce((a, u) => a + (u.costUsd ?? 0), 0);
    if (run.config.budgets.maxApiUsd && apiUsd > run.config.budgets.maxApiUsd) {
      this.emit(runId, { type: 'run.status', status: 'paused', reason: `API spend $${apiUsd.toFixed(2)} exceeded budget` });
      return;
    }

    // 5. Start ready tasks within limits.
    const ready = Object.values(s.tasks)
      .filter((t) => t.status === 'ready')
      .sort((a, b) => (a.kind === 'review' ? -1 : 0) - (b.kind === 'review' ? -1 : 0) || a.depth - b.depth || a.createdAt - b.createdAt);
    for (const t of ready) {
      if (activeAgents(s).length >= lim.maxConcurrentAgents) break;
      const totalAgents = Object.values(s.agents).filter((a) => a.status !== 'interrupted').length;
      if (totalAgents >= lim.maxTotalAgents) {
        this.emit(runId, { type: 'limit.hit', limit: 'maxTotalAgents', detail: `${totalAgents} agents spawned (max ${lim.maxTotalAgents})`, taskId: t.id }, { dedupeKey: `maxTotal:${t.id}` });
        this.emit(runId, { type: 'task.status', taskId: t.id, status: 'failed', reason: 'agent spawn limit reached' });
        continue;
      }
      const perTask = countedAttempts(s, t) + Object.values(s.tasks).filter((x) => x.reviewOf === t.id).length;
      if (perTask >= lim.maxAgentsPerTask) {
        this.emit(runId, { type: 'limit.hit', limit: 'maxAgentsPerTask', detail: `"${t.title}" used ${perTask} agents`, taskId: t.id });
        this.emit(runId, { type: 'task.status', taskId: t.id, status: 'failed', reason: 'per-task agent limit reached' });
        continue;
      }
      // Permission ceiling → explicit approval.
      const planner = t.kind === 'plan' || t.kind === 'orchestrate' || t.kind === 'synthesize';
      if (!planner && permissionRank(t.permission) > permissionRank(run.config.permissionCeiling)) {
        const ap = Object.values(s.approvals).find((a) => a.kind === 'permission' && a.taskId === t.id);
        if (!ap) {
          this.emit(runId, { type: 'approval.requested', id: id('appr'), kind: 'permission', taskId: t.id, description: `Task "${t.title}" requests "${t.permission}" permission (run ceiling: "${run.config.permissionCeiling}").`, payload: { requested: t.permission } }, { dedupeKey: `perm:${t.id}` });
          this.emit(runId, { type: 'task.status', taskId: t.id, status: 'blocked', reason: `awaiting approval for "${t.permission}"` });
          continue;
        }
        if (ap.status === 'pending') continue;
      }
      // Non-git workspaces: serialize writers to avoid clobbering.
      const perm = this.effectivePermission(s, t);
      if (permissionRank(perm) >= permissionRank('write') && !this.repoCache.get(run.workspace)?.isRepo) {
        const writer = activeAgents(s).some((a) => permissionRank(this.effectivePermission(s, s.tasks[a.taskId])) >= permissionRank('write'));
        if (writer) continue;
      }
      let decision: RoutingDecision;
      try {
        decision = this.routeTask(s, t);
      } catch (e) {
        this.emit(runId, { type: 'error', message: (e as Error).message, taskId: t.id, recoverable: false });
        this.emit(runId, { type: 'task.status', taskId: t.id, status: 'failed', reason: (e as Error).message });
        continue;
      }
      const cap = lim.providerConcurrency[decision.provider] ?? 3;
      const busy = [...this.running.values()].filter((r) => r.provider === decision.provider).length;
      if (busy >= cap) continue; // wait for a slot
      this.spawn(runId, t, decision);
    }
  }

  effectivePermission(s: RunState, t: Task): PermissionLevel {
    // Planners only read; their children carry the permissions.
    if (t.kind === 'plan' || t.kind === 'orchestrate' || t.kind === 'synthesize') return 'read';
    if (permissionRank(t.permission) <= permissionRank(s.run.config.permissionCeiling)) return t.permission;
    const ap = Object.values(s.approvals).find((a) => a.kind === 'permission' && a.taskId === t.id);
    return ap?.status === 'approved' ? t.permission : s.run.config.permissionCeiling;
  }

  private routeTask(s: RunState, t: Task): RoutingDecision {
    // Resume an interrupted session on the same model when possible.
    const last = t.agentIds.length ? s.agents[t.agentIds.at(-1)!] : undefined;
    if (last?.status === 'interrupted' && last.sessionId) {
      const m = this.models.find((x) => x.id === last.modelId && x.available);
      if (m) return { modelId: m.id, provider: m.provider, model: m.model, effort: m.effort, explanation: `Resuming interrupted session ${last.sessionId.slice(0, 8)} on ${m.label}`, candidates: [], assumptions: [], estTokens: 0 };
    }
    const saturated = new Set<string>();
    for (const [p, cap] of Object.entries(s.run.config.limits.providerConcurrency)) if ([...this.running.values()].filter((r) => r.provider === p).length >= cap) saturated.add(p);
    const quotaUtilization: Record<string, number> = {};
    for (const q of Object.values(s.quotas)) if (q.utilization !== undefined && !(q.resetsAt && q.resetsAt < Date.now())) quotaUtilization[q.provider] = Math.max(quotaUtilization[q.provider] ?? 0, q.utilization);
    let authorModelId: string | undefined;
    if (t.kind === 'review' && t.reviewOf) {
      const target = s.tasks[t.reviewOf];
      const authorAgent = target ? s.agents[target.agentIds.at(-1)!] : undefined;
      authorModelId = authorAgent?.modelId;
    }
    const task = t.kind === 'review' ? { ...t, category: 'review' as const } : t;
    return route(task, {
      models: this.models,
      stats: (m, c) => this.store.perfStats(m, c),
      saturated,
      quotaUtilization,
      allowedProviders: s.run.config.providers,
      maxRetries: s.run.config.limits.maxRetries,
      qualityBias: s.run.config.qualityBias,
      authorModelId,
    });
  }

  private roleFor(t: Task): AgentRole {
    if (t.kind === 'plan') return 'orchestrator';
    if (t.kind === 'orchestrate') return 'sub_orchestrator';
    if (t.kind === 'review') return 'reviewer';
    if (t.kind === 'synthesize') return 'synthesizer';
    return 'worker';
  }

  private parentAgentFor(s: RunState, t: Task): string | undefined {
    if (t.createdBy && s.agents[t.createdBy]) return t.createdBy;
    const parent = t.parentTaskId ? s.tasks[t.parentTaskId] : undefined;
    return parent?.agentIds.at(-1);
  }

  private spawn(runId: string, t: Task, decision: RoutingDecision) {
    const s = this.state(runId);
    const agentId = id('agent');
    const attempt = t.agentIds.filter((a) => s.agents[a]?.status !== 'interrupted').length + 1;
    const prevAgent = [...t.agentIds].reverse().map((a) => s.agents[a]).find((a) => a && a.status !== 'interrupted' && a.attempt > 0);
    const tierOf = (mid?: string) => this.models.find((m) => m.id === mid)?.tier ?? 0;
    if (prevAgent && tierOf(decision.modelId) > tierOf(prevAgent.modelId) && t.minTier <= tierOf(prevAgent.modelId)) {
      // Router-driven escalation (evidence lowered the weaker model's P(success)): make it explicit.
      this.emit(runId, { type: 'task.escalated', taskId: t.id, fromModel: prevAgent.modelId, minTier: t.minTier, reason: `router: after ${prevAgent.status} attempt on ${prevAgent.modelId}, ${decision.modelId} now has the lowest expected cost per verified result` });
    }
    this.emit(runId, { type: 'task.routed', taskId: t.id, decision });
    this.emit(runId, { type: 'task.status', taskId: t.id, status: 'running', reason: `attempt ${attempt} on ${decision.modelId}` });
    this.emit(runId, {
      type: 'agent.spawned',
      agentId,
      taskId: t.id,
      parentAgentId: this.parentAgentFor(s, t),
      role: this.roleFor(t),
      provider: decision.provider,
      model: decision.model,
      modelId: decision.modelId,
      effort: decision.effort,
      depth: t.depth,
      attempt,
    }, { correlationId: agentId });
    const abort = new AbortController();
    this.running.set(agentId, { runId, agentId, taskId: t.id, provider: decision.provider, abort });
    void this.runAgent(runId, t.id, agentId, abort)
      .catch((e) => {
        this.log(`agent ${agentId} crashed: ${(e as Error).stack}`);
        this.emit(runId, { type: 'error', message: `agent ${agentId}: ${(e as Error).message}`, agentId, taskId: t.id, recoverable: true });
        const a = this.state(runId).agents[agentId];
        if (a && (a.status === 'running' || a.status === 'starting')) this.emit(runId, { type: 'agent.status', agentId, status: 'failed', reason: (e as Error).message });
        // Orchestrator-side failure (git, filesystem…): retry, but never blame the model.
        this.onAgentFailure(runId, t.id, agentId, (e as Error).message, 'infra');
      })
      .finally(() => {
        this.running.delete(agentId);
        this.scheduleTick(runId);
      });
  }

  // ================================================================ agent execution

  private async workingDir(runId: string, t: Task, perm: PermissionLevel): Promise<{ cwd: string; branch?: string }> {
    const s = this.state(runId);
    const ws = s.run.workspace;
    let info = this.repoCache.get(ws);
    if (!info) {
      info = await repoInfo(ws);
      this.repoCache.set(ws, info);
    }
    if (!info.isRepo || !info.root) return { cwd: ws };
    const sub = ws.slice(info.root.length); // workspace may be a subdir of the repo
    // Reviewers must see exactly what the author produced: the author's worktree.
    // (Checked first: a reviewer allowed to execute tests must not get a fresh worktree.)
    if (t.kind === 'review' && t.reviewOf) {
      const target = s.tasks[t.reviewOf];
      if (target && permissionRank(this.effectivePermission(s, target)) >= permissionRank('write')) {
        const wt = await this.worktrees.forTask(info.root, runId, target.id);
        return { cwd: join(wt.path, sub) };
      }
    } else if (permissionRank(perm) >= permissionRank('write')) {
      const wt = await this.worktrees.forTask(info.root, runId, t.id);
      return { cwd: join(wt.path, sub), branch: wt.branch };
    }
    const integ = this.worktrees.integrationPath(runId);
    return { cwd: existsSync(integ) ? join(integ, sub) : ws };
  }

  /** git status of the user's own checkout, used to detect boundary violations. */
  private baselines = new Map<string, string>();
  private async checkoutStatus(ws: string): Promise<string | null> {
    const info = this.repoCache.get(ws);
    if (!info?.isRepo || !info.root) return null;
    const r = await execText('git', ['status', '--porcelain', '--untracked-files=all'], ws, 20_000);
    return r.code === 0 ? r.stdout : null;
  }

  /**
   * Audit: agents work in worktrees, so the user's checkout must not change
   * during a run. Any change is reported (never silently reverted).
   */
  private async auditBoundary(runId: string, agentId: string) {
    const ws = this.state(runId).run.workspace;
    const now = await this.checkoutStatus(ws);
    if (now === null) return;
    const base = this.baselines.get(runId);
    if (base === undefined) return void this.baselines.set(runId, now);
    if (now === base) return;
    const before = new Set(base.split('\n'));
    const changed = now.split('\n').filter((l) => l && !before.has(l));
    this.baselines.set(runId, now);
    if (!changed.length) return;
    const a = this.state(runId).agents[agentId];
    this.emit(runId, { type: 'error', message: `Boundary audit: the workspace checkout changed while ${a?.modelId ?? agentId} was running (outside its isolated worktree): ${changed.join(', ').slice(0, 500)}`, agentId, taskId: a?.taskId, recoverable: true });
    this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: `⚠ Boundary audit: files in your checkout changed during the run, outside any agent worktree:\n${changed.map((c) => `  ${c}`).join('\n')}\nThese changes were NOT made through the run branch. Review them manually (nothing was reverted).`, refs: a ? [a.taskId] : [] });
  }

  private async runAgent(runId: string, taskId: string, agentId: string, abort: AbortController) {
    let s = this.state(runId);
    if (!this.baselines.has(runId)) {
      const b = await this.checkoutStatus(s.run.workspace).catch(() => null);
      if (b !== null && !this.baselines.has(runId)) this.baselines.set(runId, b);
    }
    const t = s.tasks[taskId];
    const agent = s.agents[agentId];
    const adapter = this.adapters.get(agent.provider);
    if (!adapter) throw new Error(`no adapter for ${agent.provider}`);
    const perm = this.effectivePermission(s, t);
    const { cwd } = await this.workingDir(runId, t, perm);
    const build = this.buildPrompt(runId, t, agentId, cwd);
    const prev = t.agentIds.length > 1 ? s.agents[t.agentIds.at(-2)!] : undefined;
    const resume = prev?.status === 'interrupted' && prev.sessionId && prev.modelId === agent.modelId ? prev.sessionId : undefined;
    const prompt = resume ? 'You were interrupted (the orchestrator restarted). Continue the task from where you left off and give your complete final answer in the required format.' : build.prompt;
    this.emit(runId, { type: 'agent.output', agentId, stream: 'system', text: `context package: ${prompt.length.toLocaleString()} chars (~${Math.round(prompt.length / 4).toLocaleString()} tokens), ${build.depCount} dependency summaries${resume ? `, resuming session ${resume}` : ''} · cwd ${cwd} · permission ${perm}` });
    this.emit(runId, { type: 'agent.status', agentId, status: 'running' });

    let final: Extract<AdapterEvent, { kind: 'final' }> | undefined;
    const maxTaskTokens = s.run.config.budgets.maxTaskTokens;
    for await (const ev of adapter.run({
      agentId,
      prompt,
      systemPrompt: build.system,
      model: agent.model,
      effort: agent.effort,
      cwd,
      permission: perm,
      extraDirs: [...s.run.config.extraDirs, join(this.dataDir, 'artifacts', runId)],
      jsonSchema: build.schema,
      resumeSessionId: resume,
      timeoutMs: s.run.config.limits.taskTimeoutMs,
      signal: abort.signal,
      scratchDir: join(this.dataDir, 'scratch', runId),
    })) {
      switch (ev.kind) {
        case 'session':
          this.emit(runId, { type: 'agent.session', agentId, sessionId: ev.sessionId });
          break;
        case 'pid':
          this.emit(runId, { type: 'agent.status', agentId, status: 'running', pid: ev.pid });
          break;
        case 'text':
        case 'thinking':
        case 'stderr':
        case 'system':
          this.emit(runId, { type: 'agent.output', agentId, stream: ev.kind, text: ev.text });
          break;
        case 'tool_start':
          this.emit(runId, { type: 'tool.started', agentId, toolId: ev.id, name: ev.name, input: ev.input });
          break;
        case 'tool_end':
          this.emit(runId, { type: 'tool.finished', agentId, toolId: ev.id, ok: ev.ok, output: ev.output });
          break;
        case 'usage':
          this.emit(runId, { type: 'usage', agentId, taskId, provider: agent.provider, model: agent.model, usage: ev.usage, final: false });
          if (maxTaskTokens && billableTokens(ev.usage) > maxTaskTokens && !abort.signal.aborted) {
            this.emit(runId, { type: 'limit.hit', limit: 'budget.maxTaskTokens', detail: `agent used ${billableTokens(ev.usage)} tokens (max ${maxTaskTokens})`, taskId });
            abort.abort();
          }
          break;
        case 'quota':
          this.emit(runId, { type: 'quota', provider: agent.provider, window: ev.window, utilization: ev.utilization, resetsAt: ev.resetsAt, status: ev.status });
          break;
        case 'final':
          final = ev;
          break;
      }
    }
    await this.auditBoundary(runId, agentId).catch(() => {});
    s = this.state(runId);
    if (!final) final = { kind: 'final', ok: false, text: '', error: 'adapter ended without a result', errorClass: 'provider' };
    if (!final.ok) {
      if (final.errorClass === 'cancelled' && this.shuttingDown) {
        this.emit(runId, { type: 'agent.status', agentId, status: 'interrupted', reason: 'orchestrator shutting down' });
        return;
      }
      if (final.errorClass === 'cancelled' && s.tasks[taskId].status === 'cancelled') {
        this.emit(runId, { type: 'agent.status', agentId, status: 'cancelled', reason: 'task cancelled' });
        return;
      }
      if (final.errorClass === 'quota') {
        // Not a failed attempt: the session can be resumed once the limit resets.
        this.emit(runId, { type: 'agent.status', agentId, status: 'interrupted', reason: final.error });
        return this.onUsageLimit(runId, taskId, agentId, final.error ?? 'usage limit reached');
      }
      this.emit(runId, { type: 'agent.status', agentId, status: 'failed', reason: final.error });
      this.emit(runId, { type: 'error', message: final.error ?? 'agent failed', agentId, taskId, recoverable: true });
      this.onAgentFailure(runId, taskId, agentId, final.error ?? 'failed', final.errorClass ?? 'task');
      return;
    }
    await this.onAgentSuccess(runId, taskId, agentId, final.text, final.structured);
  }

  /** Rewrite references to any of this run's worktrees to the original workspace path. */
  neutralizePaths(runId: string, text: string): string {
    const ws = this.state(runId).run.workspace;
    const info = this.repoCache.get(ws);
    if (!info?.isRepo || !info.root) return text;
    const sub = ws.slice(info.root.length);
    const base = join(this.dataDir, 'worktrees', runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`${base}/(?:task_[a-z0-9]+|_integration)${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), ws);
  }

  private depContext(runId: string, t: Task) {
    const s = this.state(runId);
    return t.deps
      .map((d) => s.tasks[d])
      .filter(Boolean)
      .map((d) => ({
        id: d.id,
        title: d.title,
        summary: this.neutralizePaths(runId, d.resultSummary ?? '(no summary)'),
        verified: d.verified,
        artifactPaths: d.artifactIds.map((a) => s.artifacts[a]?.path).filter(Boolean) as string[],
      }));
  }

  private buildPrompt(runId: string, t: Task, agentId: string, cwd: string): { prompt: string; system: string; schema?: object; depCount: number } {
    const s = this.state(runId);
    const run = s.run;
    const parent = t.parentTaskId ? s.tasks[t.parentTaskId] : undefined;
    switch (t.kind) {
      case 'plan':
        if (t.mode === 'replan') return { prompt: replanPrompt(s, t.objective), system: SYSTEM_PLANNER, schema: REPLAN_SCHEMA, depCount: 0 };
        return { prompt: planPrompt({ objective: t.objective, workspace: cwd, extraDirs: run.config.extraDirs, ceiling: run.config.permissionCeiling, depth: t.depth, maxDepth: run.config.limits.maxDepth }), system: SYSTEM_PLANNER, schema: PLAN_SCHEMA, depCount: 0 };
      case 'orchestrate': {
        const deps = this.depContext(runId, t);
        const parentContext = `Run objective: ${run.objective.slice(0, 600)}\n${deps.map((d) => `Input "${d.title}": ${d.summary.slice(0, 600)} (${d.artifactPaths.join(', ')})`).join('\n')}`;
        const objective = `${t.title}\n${t.objective}\nAcceptance:\n${t.acceptance.map((a) => `- ${a}`).join('\n')}`;
        return { prompt: planPrompt({ objective, workspace: cwd, extraDirs: run.config.extraDirs, ceiling: run.config.permissionCeiling, parentContext, depth: t.depth, maxDepth: run.config.limits.maxDepth }), system: SYSTEM_PLANNER, schema: PLAN_SCHEMA, depCount: deps.length };
      }
      case 'review': {
        const target = s.tasks[t.reviewOf!];
        const report = target.artifactIds.map((a) => s.artifacts[a]).filter((a) => a?.kind === 'report').at(-1);
        const diff = target.artifactIds.map((a) => s.artifacts[a]).filter((a) => a?.kind === 'diff').at(-1);
        const read = (p?: string) => (p && existsSync(p) ? readFileSync(p, 'utf8') : '');
        return {
          prompt: reviewPrompt({ target, report: read(report?.path), reportPath: report?.path ?? '(none)', diff: read(diff?.path) || undefined, workspace: cwd, crosscheck: target.verification === 'crosscheck' }),
          system: SYSTEM_REVIEWER,
          schema: REVIEW_SCHEMA,
          depCount: 1,
        };
      }
      case 'synthesize': {
        const siblings = t.deps.map((d) => s.tasks[d]).filter(Boolean);
        const parts = siblings.map((x) => ({
          id: x.id,
          title: x.title,
          status: x.status,
          verified: x.verified,
          summary: x.resultSummary ?? x.statusReason ?? '',
          reviews: x.reviewIds.map((r) => s.reviews[r]).filter(Boolean).map((r) => `${r.verdict} (${r.confidence.toFixed(2)}): ${r.summary.slice(0, 300)}`).join(' | '),
          artifactPaths: x.artifactIds.map((a) => s.artifacts[a]?.path).filter(Boolean) as string[],
        }));
        return { prompt: synthesisPrompt({ objective: parent?.objective ?? run.objective, parts, isRoot: !parent?.parentTaskId }), system: SYSTEM_WORKER, depCount: parts.length };
      }
      default: {
        const deps = this.depContext(runId, t);
        const lim = run.config.limits;
        const canDelegate = t.depth < lim.maxDepth && Object.keys(s.tasks).length < lim.maxTasks - 3;
        return {
          prompt: workPrompt({ task: t, runObjective: run.objective, parentObjective: parent?.kind === 'orchestrate' ? parent.objective : undefined, deps, workspace: cwd, originalWorkspace: run.workspace, canDelegate, reportPath: '' }),
          system: SYSTEM_WORKER,
          depCount: deps.length,
        };
      }
    }
  }

  // ================================================================ outcomes

  private recordPerf(runId: string, taskId: string, agentId: string, success: boolean, verified: boolean | null, failureReason?: string) {
    const s = this.state(runId);
    const a = s.agents[agentId];
    const t = s.tasks[taskId];
    if (!a || !t) return;
    this.store.recordPerf({
      modelId: a.modelId,
      category: t.kind === 'review' ? 'review' : t.category,
      complexity: t.complexity,
      success,
      verified,
      tokens: billableTokens(a.usage),
      durationMs: (a.endedAt ?? Date.now()) - a.startedAt,
      attempt: a.attempt,
      failureReason,
      runId,
      taskId,
    });
  }

  /**
   * A provider's usage limit is exhausted. Re-queue the task without spending a
   * retry, pause the run (running agents finish) and auto-resume at the reset.
   */
  private onUsageLimit(runId: string, taskId: string, agentId: string, error: string) {
    const s = this.state(runId);
    const t = s.tasks[taskId];
    const a = s.agents[agentId];
    if (t && !isTerminal(t)) this.emit(runId, { type: 'task.status', taskId, status: 'ready', reason: `waiting for ${a?.provider ?? 'provider'} usage limit to reset` });
    const resets = Object.values(s.quotas)
      .filter((q) => q.provider === a?.provider && q.status === 'rejected' && q.resetsAt && q.resetsAt > Date.now())
      .map((q) => q.resetsAt!);
    const hinted = retryAfterMs(error);
    // Unknown reset time: probe again in 30 minutes (a still-limited agent fails fast and re-pauses).
    const resumeAt = (resets.length ? Math.max(...resets) : hinted ? Date.now() + hinted : Date.now() + 30 * 60_000) + 60_000;
    if (s.run.status === 'running' || s.run.status === 'planning') {
      const when = new Date(resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: `${a?.provider ?? 'Provider'} usage limit reached (${error.slice(0, 160)}). Run paused; it will auto-resume at ${when}, or press Resume to try sooner.` });
      this.emit(runId, { type: 'run.status', status: 'paused', reason: `${a?.provider ?? 'provider'} usage limit; auto-resume at ${when}`, resumeAt });
      this.armAutoResume(runId, resumeAt);
    } else if (s.run.status === 'paused' && s.run.resumeAt && resumeAt > s.run.resumeAt) {
      // Already paused for another provider's limit: wait for the later reset.
      this.emit(runId, { type: 'run.status', status: 'paused', reason: `${s.run.statusReason ?? 'usage limit'}; extended to ${new Date(resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, resumeAt });
      this.armAutoResume(runId, resumeAt);
    }
  }

  private onAgentFailure(runId: string, taskId: string, agentId: string, error: string, cls: ErrorClass | 'infra') {
    const s = this.state(runId);
    const t = s.tasks[taskId];
    const a = s.agents[agentId];
    if (!t || isTerminal(t)) return;
    const lim = s.run.config.limits;
    if (cls === 'infra') {
      // Not the model's fault: no perf record, no exclusion.
    } else if (cls === 'provider') {
      // Provider problem (auth, rate limit, crash): route around it, don't blame the model.
      this.emit(runId, { type: 'task.escalated', taskId, fromModel: a.modelId, minTier: t.minTier, excludeModel: a.modelId, reason: `provider error: ${error.slice(0, 200)}` });
    } else {
      this.recordPerf(runId, taskId, agentId, false, null, cls === 'timeout' ? 'timeout' : error.slice(0, 200));
      const failures = t.agentIds.slice(t.attemptFloor ?? 0).filter((x) => s.agents[x]?.status === 'failed').length;
      if (failures >= 2 || cls === 'timeout') {
        const tier = this.models.find((m) => m.id === a.modelId)?.tier ?? 1;
        this.emit(runId, { type: 'task.escalated', taskId, fromModel: a.modelId, minTier: Math.min(4, tier + 1), excludeModel: a.modelId, reason: `${failures} failed attempt(s): ${error.slice(0, 160)}` });
      }
    }
    const attempts = countedAttempts(s, t);
    if (attempts <= lim.maxRetries) {
      this.emit(runId, { type: 'task.feedback', taskId, feedback: `Previous attempt failed: ${error.slice(0, 800)}` });
      this.emit(runId, { type: 'task.status', taskId, status: 'ready', reason: `retrying after failure (${attempts}/${lim.maxRetries + 1})` });
    } else {
      this.emit(runId, { type: 'task.status', taskId, status: 'failed', reason: `failed after ${attempts} attempts: ${error.slice(0, 200)}` });
      if (t.kind === 'review' && t.reviewOf) {
        // Review could not be performed: target stays unverified but usable.
        const target = s.tasks[t.reviewOf];
        if (target?.status === 'awaiting_review') this.emit(runId, { type: 'task.status', taskId: target.id, status: 'completed', reason: 'review could not be completed; result UNVERIFIED' });
      }
    }
    this.scheduleTick(runId);
  }

  private async onAgentSuccess(runId: string, taskId: string, agentId: string, text: string, structured: unknown) {
    const s = this.state(runId);
    const t = s.tasks[taskId];
    if (!t || t.status === 'cancelled') {
      this.emit(runId, { type: 'agent.status', agentId, status: 'cancelled', reason: 'task cancelled' });
      return;
    }
    switch (t.kind) {
      case 'plan':
      case 'orchestrate':
        return this.handlePlan(runId, t, agentId, text, structured);
      case 'review':
        return this.handleReview(runId, t, agentId, text, structured);
      case 'synthesize': {
        const art = this.writeArtifact(runId, t.id, agentId, 'report', 'report.md', t.title, text, extractSummary(text));
        this.emit(runId, { type: 'agent.status', agentId, status: 'completed' });
        this.emit(runId, { type: 'task.result', taskId: t.id, summary: extractSummary(text) });
        this.emit(runId, { type: 'task.status', taskId: t.id, status: 'completed' });
        void art;
        return;
      }
      default:
        return this.handleWork(runId, t, agentId, text);
    }
  }

  private handlePlan(runId: string, t: Task, agentId: string, text: string, structured: unknown) {
    const s = this.state(runId);
    if (t.mode === 'replan') {
      const r = parseStructured<{ reply: string; add: PlannedTask[]; cancel: string[] }>(structured, text);
      if (!r) return this.planFailed(runId, t, agentId, 'could not parse replan output');
      this.emit(runId, { type: 'agent.status', agentId, status: 'completed' });
      const root = s.tasks[t.parentTaskId!];
      for (const c of r.cancel ?? []) if (s.tasks[c] && !isTerminal(s.tasks[c]) && c !== t.id && c !== root.id) this.cancelTask(runId, c, 'cancelled by orchestrator after follow-up', false);
      let created: string[] = [];
      if (r.add?.length) {
        try {
          created = this.materialize(runId, root, agentId, r.add, { existing: true });
        } catch (e) {
          return this.planFailed(runId, t, agentId, (e as Error).message);
        }
        if (['completed', 'failed'].includes(this.state(runId).run.status)) this.emit(runId, { type: 'run.status', status: 'running', reason: 'follow-up added work' });
      }
      this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'orchestrator', agentId, text: r.reply || (created.length ? `Added ${created.length} task(s).` : 'No changes needed.'), refs: created });
      this.writeArtifact(runId, t.id, agentId, 'plan', 'replan.json', 'Follow-up plan', JSON.stringify(r, null, 2));
      this.emit(runId, { type: 'task.result', taskId: t.id, summary: r.reply });
      this.emit(runId, { type: 'task.status', taskId: t.id, status: 'completed' });
      this.recordPerf(runId, t.id, agentId, true, null);
      return;
    }
    const plan = parseStructured<Plan>(structured, text);
    if (!plan?.tasks?.length) return this.planFailed(runId, t, agentId, 'plan output missing or empty');
    let created: string[];
    try {
      created = this.materialize(runId, t, agentId, plan.tasks);
    } catch (e) {
      return this.planFailed(runId, t, agentId, (e as Error).message);
    }
    this.writeArtifact(runId, t.id, agentId, 'plan', 'plan.json', `Plan: ${t.title}`, JSON.stringify(plan, null, 2), plan.summary);
    this.emit(runId, { type: 'agent.status', agentId, status: 'completed' });
    this.emit(runId, { type: 'task.result', taskId: t.id, summary: plan.summary });
    if (!t.parentTaskId) this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'orchestrator', agentId, text: `${plan.reply}\n\n${plan.summary}`, refs: created });
    else if (t.kind === 'orchestrate') this.emit(runId, { type: 'agent.role', agentId, role: 'sub_orchestrator', reason: `planned ${created.length} sub-tasks` });
    this.recordPerf(runId, t.id, agentId, true, null);
  }

  private planFailed(runId: string, t: Task, agentId: string, reason: string) {
    this.emit(runId, { type: 'agent.status', agentId, status: 'failed', reason });
    this.onAgentFailure(runId, t.id, agentId, `Invalid plan: ${reason}. Return valid structured output.`, 'task');
  }

  private async handleWork(runId: string, t: Task, agentId: string, text: string) {
    const s = this.state(runId);
    const lim = s.run.config.limits;
    // Worker-initiated promotion to sub-orchestrator.
    const del = extractDelegation(text);
    if (del) {
      this.emit(runId, { type: 'delegation.requested', agentId, taskId: t.id, reason: del.reason, subtasks: del.tasks.length });
      const depthOk = t.depth < lim.maxDepth;
      const room = Object.keys(s.tasks).length + del.tasks.length + 1 <= lim.maxTasks;
      const approved = depthOk && room && del.tasks.length >= 2;
      const why = !depthOk ? `max delegation depth ${lim.maxDepth} reached` : !room ? `would exceed max ${lim.maxTasks} tasks` : del.tasks.length < 2 ? 'fewer than 2 sub-tasks: do it directly' : 'within limits';
      this.emit(runId, { type: 'delegation.decided', agentId, taskId: t.id, approved, reason: why });
      if (approved) {
        try {
          this.emit(runId, { type: 'agent.role', agentId, role: 'sub_orchestrator', reason: del.reason });
          this.materialize(runId, t, agentId, del.tasks);
          this.emit(runId, { type: 'agent.status', agentId, status: 'completed', reason: 'promoted to sub-orchestrator' });
          return;
        } catch (e) {
          this.emit(runId, { type: 'delegation.decided', agentId, taskId: t.id, approved: false, reason: (e as Error).message });
        }
      }
      this.emit(runId, { type: 'agent.status', agentId, status: 'completed', reason: 'delegation denied' });
      this.emit(runId, { type: 'task.feedback', taskId: t.id, feedback: `Delegation was denied (${why}). Complete the task directly.` });
      this.emit(runId, { type: 'task.status', taskId: t.id, status: 'ready', reason: 'delegation denied; doing the work directly' });
      return;
    }
    const summary = extractSummary(text);
    this.writeArtifact(runId, t.id, agentId, 'report', `report-${agentId}.md`, `${t.title} — report`, text, summary);
    const perm = this.effectivePermission(s, t);
    if (permissionRank(perm) >= permissionRank('write')) {
      const info = this.repoCache.get(s.run.workspace);
      if (info?.isRepo && info.root) {
        const wt = await this.worktrees.forTask(info.root, runId, t.id);
        const diff = await this.worktrees.diff(wt.path);
        if (diff.trim()) this.writeArtifact(runId, t.id, agentId, 'diff', `changes-${agentId}.diff`, `${t.title} — changes`, diff, `${(await this.worktrees.changedFiles(wt.path)).length} file(s) changed on ${wt.branch}`);
      }
    }
    this.emit(runId, { type: 'agent.status', agentId, status: 'completed' });
    this.emit(runId, { type: 'task.result', taskId: t.id, summary });
    if (t.verification === 'none') {
      this.recordPerf(runId, t.id, agentId, true, null);
      this.emit(runId, { type: 'task.status', taskId: t.id, status: 'completed', reason: 'no verification required' });
      await this.afterWork(runId, t.id, agentId);
      return;
    }
    this.emit(runId, { type: 'task.status', taskId: t.id, status: 'awaiting_review' });
    const parent = t.parentTaskId ? this.state(runId).tasks[t.parentTaskId] : undefined;
    const round = this.state(runId).tasks[t.id].reviewIds.length + 1;
    this.createTask(
      runId,
      {
        title: `${t.verification === 'crosscheck' ? 'Cross-check' : 'Review'}: ${t.title}`.slice(0, 80),
        objective: `Independently ${t.verification === 'crosscheck' ? 'cross-check' : 'review'} "${t.title}"`,
        kind: 'review',
        category: t.category,
        complexity: t.complexity,
        criticality: t.criticality,
        acceptance: t.acceptance,
        verification: 'none',
        // Reviewers may run tests only if the run ceiling already allows it.
        permission: permissionRank(perm) >= permissionRank('execute') && permissionRank(s.run.config.permissionCeiling) >= permissionRank('execute') ? 'execute' : 'read',
      },
      { parentTaskId: t.parentTaskId, createdBy: parent?.agentIds.at(-1), depth: t.depth, deps: [t.id], reviewOf: t.id },
      `review:${agentId}:${round}`,
    );
    // Reviews depend on a task in awaiting_review, so mark ready directly.
    const rv = Object.values(this.state(runId).tasks).filter((x) => x.reviewOf === t.id).at(-1);
    if (rv && rv.status === 'pending') this.emit(runId, { type: 'task.status', taskId: rv.id, status: 'ready' });
  }

  /** Post-completion hooks: integrate verified write work into the run branch. */
  private async afterWork(runId: string, taskId: string, _agentId: string | undefined) {
    const s = this.state(runId);
    const t = s.tasks[taskId];
    const info = this.repoCache.get(s.run.workspace);
    if (!info?.isRepo || !info.root || permissionRank(this.effectivePermission(s, t)) < permissionRank('write') || t.kind !== 'work') return;
    const wt = await this.worktrees.forTask(info.root, runId, t.id);
    const res = await this.worktrees.integrate(runId, wt.path, wt.branch, `synape: ${t.title}\n\nTask ${t.id}${t.verified ? ' (independently verified)' : ' (unverified)'}`);
    if (res.ok) this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: `Merged "${t.title}" into ${this.worktrees.integrationBranch(runId)}${res.commit ? ` @ ${res.commit}` : ''} (local only).`, refs: [t.id] });
    else {
      this.emit(runId, { type: 'error', message: `merge conflict integrating "${t.title}": ${res.conflict}`, taskId, recoverable: true });
      this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: `Could not merge "${t.title}" into the run branch automatically (conflict). Its branch ${wt.branch} is preserved for manual resolution.`, refs: [t.id] });
    }
  }

  private async handleReview(runId: string, rt: Task, agentId: string, text: string, structured: unknown) {
    const s = this.state(runId);
    const v = parseStructured<{ verdict: 'pass' | 'revise' | 'fail'; confidence: number; summary: string; issues: { severity: 'minor' | 'major' | 'critical'; description: string }[] }>(structured, text);
    if (!v || !['pass', 'revise', 'fail'].includes(v.verdict)) return this.planFailed(runId, rt, agentId, 'could not parse review verdict');
    const target = s.tasks[rt.reviewOf!];
    const authorAgentId = target.agentIds.filter((a) => s.agents[a]?.role !== 'sub_orchestrator').at(-1)!;
    const verdictId = id('rev');
    this.emit(runId, {
      type: 'review.verdict',
      id: verdictId,
      reviewTaskId: rt.id,
      targetTaskId: target.id,
      reviewerAgentId: agentId,
      verdict: v.verdict,
      confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
      summary: String(v.summary ?? ''),
      issues: (v.issues ?? []).slice(0, 30),
    });
    this.writeArtifact(runId, rt.id, agentId, 'verdict', 'verdict.json', rt.title, JSON.stringify(v, null, 2), `${v.verdict}: ${v.summary}`);
    this.emit(runId, { type: 'agent.status', agentId, status: 'completed' });
    this.emit(runId, { type: 'task.result', taskId: rt.id, summary: `${v.verdict} (${v.confidence}): ${v.summary}` });
    this.emit(runId, { type: 'task.status', taskId: rt.id, status: 'completed' });
    this.recordPerf(runId, rt.id, agentId, true, null);
    if (target.status !== 'awaiting_review') return;

    if (v.verdict === 'pass') {
      this.recordPerf(runId, target.id, authorAgentId, true, true);
      this.emit(runId, { type: 'task.result', taskId: target.id, summary: target.resultSummary ?? '', verified: true });
      this.emit(runId, { type: 'task.status', taskId: target.id, status: 'completed', reason: `verified by independent ${s.agents[agentId]?.modelId ?? 'reviewer'}` });
      await this.afterWork(runId, target.id, authorAgentId);
      return;
    }
    this.recordPerf(runId, target.id, authorAgentId, false, false, `review ${v.verdict}`);
    const lim = s.run.config.limits;
    const attempts = countedAttempts(s, target);
    const issues = (v.issues ?? []).map((i) => `- [${i.severity}] ${i.description}`).join('\n');
    if (attempts <= lim.maxRetries) {
      const author = s.agents[authorAgentId];
      const tier = this.models.find((m) => m.id === author?.modelId)?.tier ?? 1;
      // Escalate on evidence: a "fail" verdict, or a second rejection.
      if (v.verdict === 'fail' || target.reviewIds.length >= 2) this.emit(runId, { type: 'task.escalated', taskId: target.id, fromModel: author.modelId, minTier: Math.min(4, tier + 1), excludeModel: author.modelId, reason: `independent review: ${v.verdict}` });
      this.emit(runId, { type: 'task.feedback', taskId: target.id, feedback: `Independent reviewer verdict: ${v.verdict} (confidence ${v.confidence}).\n${v.summary}\n${issues}` });
      this.emit(runId, { type: 'task.status', taskId: target.id, status: 'ready', reason: `revision requested by review (${v.verdict})` });
    } else {
      // Out of retries: keep the result but record the unresolved disagreement.
      this.emit(runId, { type: 'task.result', taskId: target.id, summary: `${target.resultSummary ?? ''}\n\n⚠ UNRESOLVED REVIEW DISAGREEMENT (${v.verdict}): ${v.summary}`, verified: false });
      this.emit(runId, { type: 'task.status', taskId: target.id, status: 'completed', reason: 'completed UNVERIFIED: reviewer disagreement unresolved after max retries' });
    }
  }

  // ================================================================ chat

  /** Follow-up instruction to the orchestrator, or a question to one agent. */
  postMessage(runId: string, text: string, agentId?: string) {
    const s = this.state(runId);
    this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'user', agentId, text });
    if (agentId) return void this.converse(runId, agentId, text);
    const root = s.run.rootTaskId ? s.tasks[s.run.rootTaskId] : undefined;
    if (!root) return;
    if (root.status !== 'delegated' && root.status !== 'completed') {
      this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: 'The orchestrator is still planning; your message will be considered once the plan exists. (Re-send it then, or cancel and restart with the combined instruction.)' });
      return;
    }
    if (root.status === 'completed') this.emit(runId, { type: 'task.status', taskId: root.id, status: 'delegated', reason: 'follow-up instruction' });
    if (s.run.status !== 'running') this.emit(runId, { type: 'run.status', status: 'running', reason: 'follow-up instruction' });
    this.createTask(runId, {
      title: `Follow-up: ${text.slice(0, 50)}`,
      objective: text,
      kind: 'plan',
      mode: 'replan',
      category: 'planning',
      complexity: 2,
      criticality: 2,
      acceptance: ['Graph updated to reflect the instruction'],
      verification: 'none',
      permission: 'read',
    }, { parentTaskId: root.id, depth: 1, deps: [] });
    this.scheduleTick(runId);
  }

  /** Ask a finished agent a question by resuming its own session (read-only). */
  private async converse(runId: string, agentId: string, question: string) {
    const s = this.state(runId);
    const a = s.agents[agentId];
    const adapter = a ? this.adapters.get(a.provider) : undefined;
    if (!a || !adapter) return;
    if (a.status === 'running' || a.status === 'starting') {
      this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: 'This agent is still running and cannot take questions mid-task. Ask again when it finishes, or use the orchestrator chat to redirect work.' });
      return;
    }
    if (!a.sessionId) {
      this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: 'This agent has no resumable session.' });
      return;
    }
    const qid = id('agent');
    this.emit(runId, { type: 'agent.spawned', agentId: qid, taskId: a.taskId, parentAgentId: agentId, role: 'worker', provider: a.provider, model: a.model, modelId: a.modelId, effort: a.effort, depth: a.depth, attempt: 0 }, { correlationId: qid });
    this.emit(runId, { type: 'agent.status', agentId: qid, status: 'running', reason: 'answering a user question (read-only, resumed session)' });
    const abort = new AbortController();
    this.running.set(qid, { runId, agentId: qid, taskId: a.taskId, provider: a.provider, abort });
    let answer = '';
    let ok = false;
    try {
      for await (const ev of adapter.run({
        agentId: qid,
        prompt: `The user asks (answer concisely; do not modify anything):\n${question}`,
        model: a.model,
        effort: a.effort,
        cwd: s.run.workspace,
        permission: 'read',
        extraDirs: [...s.run.config.extraDirs, join(this.dataDir, 'artifacts', runId)],
        resumeSessionId: a.sessionId,
        timeoutMs: 10 * 60_000,
        signal: abort.signal,
        scratchDir: join(this.dataDir, 'scratch', runId),
      })) {
        if (ev.kind === 'usage') this.emit(runId, { type: 'usage', agentId: qid, taskId: a.taskId, provider: a.provider, model: a.model, usage: ev.usage, final: false });
        else if (ev.kind === 'tool_start') this.emit(runId, { type: 'tool.started', agentId: qid, toolId: ev.id, name: ev.name, input: ev.input });
        else if (ev.kind === 'tool_end') this.emit(runId, { type: 'tool.finished', agentId: qid, toolId: ev.id, ok: ev.ok, output: ev.output });
        else if (ev.kind === 'text') this.emit(runId, { type: 'agent.output', agentId: qid, stream: 'text', text: ev.text });
        else if (ev.kind === 'final') {
          ok = ev.ok;
          answer = ev.ok ? ev.text : `Could not answer: ${ev.error}`;
        }
      }
    } finally {
      this.running.delete(qid);
    }
    this.emit(runId, { type: 'agent.status', agentId: qid, status: ok ? 'completed' : 'failed' });
    this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'agent', agentId, text: answer, refs: [a.taskId] });
  }

  // ================================================================ git publication

  /** Request a git action; it executes only after explicit approval. */
  async requestGitAction(runId: string, kind: 'git-commit' | 'git-push' | 'pull-request') {
    const s = this.state(runId);
    const info = await repoInfo(s.run.workspace, kind !== 'git-commit');
    if (!info.isRepo) throw new Error('workspace is not a git repository');
    const branch = this.worktrees.integrationBranch(runId);
    const desc =
      kind === 'git-commit'
        ? `Merge run branch ${branch} into your checked-out branch "${info.branch}" (local only).`
        : kind === 'git-push'
          ? `Push branch ${branch} to remote "${info.remotes?.[0]?.name ?? 'origin'}" (${info.remotes?.[0]?.url ?? 'no remote'}). This publishes the agents' changes.`
          : `Open a GitHub pull request from ${branch}. This publishes the changes and the PR description.`;
    this.emit(runId, { type: 'approval.requested', id: id('appr'), kind, description: desc, payload: { branch, root: info.root, remote: info.remotes?.[0]?.name } });
  }

  private async performGitAction(runId: string, kind: 'git-commit' | 'git-push' | 'pull-request', p: { branch: string; root: string; remote?: string }) {
    const s = this.state(runId);
    let res: { code: number | null; stdout: string; stderr: string };
    if (kind === 'git-commit') res = await execText('git', ['merge', '--no-ff', '-m', `Merge synape run "${s.run.title}"`, p.branch], p.root, 60_000);
    else if (kind === 'git-push') res = await execText('git', ['push', '-u', p.remote ?? 'origin', p.branch], p.root, 120_000);
    else {
      const final = s.run.finalArtifactId ? s.artifacts[s.run.finalArtifactId] : undefined;
      const body = `${final && existsSync(final.path) ? extractSummary(readFileSync(final.path, 'utf8')) : s.run.objective.slice(0, 500)}\n\n---\nPrepared by a Synape run (${runId}).`;
      res = await execText('gh', ['pr', 'create', '--head', p.branch, '--title', s.run.title.slice(0, 70), '--body', body], p.root, 120_000);
    }
    const ok = res.code === 0;
    this.emit(runId, { type: 'chat.message', messageId: id('msg'), from: 'system', text: `${kind} ${ok ? 'succeeded' : 'failed'}: ${(res.stdout + res.stderr).trim().slice(0, 1200)}` });
  }
}
