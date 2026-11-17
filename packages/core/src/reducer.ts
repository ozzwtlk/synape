import type { EventEnvelope } from './events.ts';
import type { Agent, RunState, Task, Usage } from './types.ts';
import { DEFAULT_CONFIG, STATE_SCHEMA, emptyUsage } from './types.ts';
import { classifyCompute } from './compute.ts';

const OUTPUT_TAIL = 80;
const TOOL_TAIL = 60;
const SIGNAL_TAIL = 48;

export function initialState(runId = ''): RunState {
  return {
    schema: STATE_SCHEMA,
    run: { id: runId, title: '', objective: '', workspace: '', config: DEFAULT_CONFIG, status: 'planning', createdAt: 0 },
    tasks: {},
    agents: {},
    artifacts: {},
    reviews: {},
    messages: [],
    approvals: {},
    quotas: {},
    usageByProvider: {},
    totals: { ...emptyUsage(), retryTokens: 0, reviewTokens: 0, duplicateRejected: 0 },
    limitEvents: [],
    escalations: [],
    signals: [],
    lastSeq: 0,
    lastTs: 0,
  };
}

export const billableTokens = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheWriteTokens;

function addUsage(into: Usage, d: Usage) {
  into.inputTokens += d.inputTokens;
  into.outputTokens += d.outputTokens;
  into.cacheReadTokens += d.cacheReadTokens;
  into.cacheWriteTokens += d.cacheWriteTokens;
  into.reasoningTokens += d.reasoningTokens;
  if (d.costUsd !== undefined) into.costUsd = (into.costUsd ?? 0) + d.costUsd;
  if (d.durationMs !== undefined) into.durationMs = (into.durationMs ?? 0) + d.durationMs;
  if (d.costBasis !== 'unavailable') into.costBasis = d.costBasis;
  if (d.peakContextTokens !== undefined) into.peakContextTokens = Math.max(into.peakContextTokens ?? 0, d.peakContextTokens);
  if (d.contextWindow !== undefined) into.contextWindow = d.contextWindow;
}

function diffUsage(next: Usage, prev: Usage): Usage {
  return {
    inputTokens: next.inputTokens - prev.inputTokens,
    outputTokens: next.outputTokens - prev.outputTokens,
    cacheReadTokens: next.cacheReadTokens - prev.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens - prev.cacheWriteTokens,
    reasoningTokens: next.reasoningTokens - prev.reasoningTokens,
    costUsd: next.costUsd !== undefined ? next.costUsd - (prev.costUsd ?? 0) : undefined,
    durationMs: next.durationMs !== undefined ? next.durationMs - (prev.durationMs ?? 0) : undefined,
    costBasis: next.costBasis,
    peakContextTokens: next.peakContextTokens,
    contextWindow: next.contextWindow,
  };
}

function pushBounded<T>(arr: T[], item: T, max: number) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function signal(s: RunState, from: string | undefined, to: string | undefined, kind: RunState['signals'][number]['kind'], seq: number) {
  if (!from || !to) return;
  pushBounded(s.signals, { from, to, kind, seq }, SIGNAL_TAIL);
}

/**
 * Apply one event to state, in place. Deterministic and side-effect free apart
 * from mutating `s`. Unknown references are ignored rather than thrown so that
 * replay of a partially corrupted log degrades gracefully.
 */
export function applyEvent(s: RunState, e: EventEnvelope): RunState {
  const b = e.body;
  s.lastSeq = e.seq;
  s.lastTs = e.ts;
  switch (b.type) {
    case 'run.created':
      s.run = { id: b.runId, title: b.title, objective: b.objective, workspace: b.workspace, config: b.config, status: 'planning', createdAt: e.ts };
      break;
    case 'run.status':
      s.run.status = b.status;
      s.run.statusReason = b.reason;
      s.run.resumeAt = b.resumeAt;
      if (['completed', 'failed', 'cancelled'].includes(b.status)) s.run.endedAt = e.ts;
      else s.run.endedAt = undefined;
      break;
    case 'run.config':
      s.run.config = b.config;
      break;
    case 'chat.message':
      s.messages.push({ id: b.messageId, from: b.from, agentId: b.agentId, text: b.text, refs: b.refs, ts: e.ts });
      break;
    case 'task.created': {
      const { type: _t, taskId, ...spec } = b;
      const t: Task = {
        ...spec,
        id: taskId,
        status: 'pending',
        attempts: 0,
        agentIds: [],
        minTier: 1,
        excludedModels: [],
        artifactIds: [],
        reviewIds: [],
        verified: false,
        usage: emptyUsage(),
        createdAt: e.ts,
      };
      s.tasks[taskId] = t;
      if (!s.run.rootTaskId && b.kind === 'plan' && !b.parentTaskId) s.run.rootTaskId = taskId;
      const parent = b.parentTaskId ? s.tasks[b.parentTaskId] : undefined;
      if (parent) signal(s, parent.agentIds.at(-1), taskId, 'delegation', e.seq);
      break;
    }
    case 'task.deps': {
      const t = s.tasks[b.taskId];
      if (t) t.deps = b.deps;
      break;
    }
    case 'task.status': {
      const t = s.tasks[b.taskId];
      if (!t) break;
      t.status = b.status;
      t.statusReason = b.reason;
      if (b.status === 'running') {
        t.startedAt ??= e.ts;
        t.endedAt = undefined;
      }
      if (['completed', 'failed', 'cancelled'].includes(b.status)) t.endedAt = e.ts;
      if (b.status === 'completed') {
        // Result flows to dependants.
        for (const other of Object.values(s.tasks)) if (other.deps.includes(t.id)) signal(s, t.id, other.id, 'handoff', e.seq);
      }
      break;
    }
    case 'task.routed': {
      const t = s.tasks[b.taskId];
      if (t) t.routing = b.decision;
      break;
    }
    case 'task.result': {
      const t = s.tasks[b.taskId];
      if (!t) break;
      t.resultSummary = b.summary;
      if (b.tldr !== undefined) t.resultTldr = b.tldr;
      if (b.verified !== undefined) t.verified = b.verified;
      break;
    }
    case 'task.outputs': {
      const t = s.tasks[b.taskId];
      if (!t) break;
      const byRel = new Map((t.outputs ?? []).map((f) => [f.rel, f]));
      for (const f of b.files) byRel.set(f.rel, { ...f, agentId: b.agentId });
      t.outputs = [...byRel.values()].sort((x, y) => y.mtime - x.mtime).slice(0, 300);
      break;
    }
    case 'task.feedback': {
      const t = s.tasks[b.taskId];
      if (t) t.feedback = b.feedback;
      break;
    }
    case 'task.model': {
      const t = s.tasks[b.taskId];
      if (t) t.pinnedModel = b.modelId;
      break;
    }
    case 'task.reopened': {
      // Fresh start after a failure that wasn't the task's fault (usage limit, user resume).
      const t = s.tasks[b.taskId];
      if (!t) break;
      t.status = b.status;
      t.statusReason = b.reason;
      t.endedAt = undefined;
      t.attemptFloor = t.agentIds.length;
      t.excludedModels = [];
      t.feedback = undefined;
      break;
    }
    case 'task.escalated': {
      const t = s.tasks[b.taskId];
      if (!t) break;
      t.minTier = Math.max(t.minTier, b.minTier);
      if (b.excludeModel && !t.excludedModels.includes(b.excludeModel)) t.excludedModels.push(b.excludeModel);
      s.escalations.push({ taskId: b.taskId, from: b.fromModel, reason: b.reason, ts: e.ts });
      break;
    }
    case 'agent.spawned': {
      const a: Agent = {
        id: b.agentId,
        taskId: b.taskId,
        parentAgentId: b.parentAgentId,
        role: b.role,
        provider: b.provider,
        model: b.model,
        modelId: b.modelId,
        effort: b.effort,
        depth: b.depth,
        attempt: b.attempt,
        status: 'starting',
        usage: emptyUsage(),
        toolCalls: [],
        toolCount: 0,
        outputTail: [],
        lastActivity: e.ts,
        startedAt: e.ts,
      };
      s.agents[b.agentId] = a;
      const t = s.tasks[b.taskId];
      if (t) {
        t.agentIds.push(b.agentId);
        t.attempts = Math.max(t.attempts, b.attempt);
      }
      signal(s, b.parentAgentId, b.agentId, 'delegation', e.seq);
      break;
    }
    case 'agent.status': {
      const a = s.agents[b.agentId];
      if (!a) break;
      a.status = b.status;
      a.statusReason = b.reason;
      if (b.pid !== undefined) a.pid = b.pid;
      a.lastActivity = e.ts;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(b.status)) {
        a.endedAt = e.ts;
        // A finished agent has no computations still running.
        const t = s.tasks[a.taskId];
        for (const [toolId, o] of Object.entries(t?.computeOpen ?? {})) {
          if (o.agentId !== a.id) continue;
          const c = t!.computes![o.program];
          c.running = Math.max(0, c.running - 1);
          delete t!.computeOpen![toolId];
        }
        if (b.status === 'completed') signal(s, b.agentId, a.parentAgentId, 'result', e.seq);
      }
      break;
    }
    case 'agent.role': {
      const a = s.agents[b.agentId];
      if (a) a.role = b.role;
      break;
    }
    case 'agent.session': {
      const a = s.agents[b.agentId];
      if (a) a.sessionId = b.sessionId;
      break;
    }
    case 'agent.output': {
      const a = s.agents[b.agentId];
      if (!a) break;
      a.lastActivity = e.ts;
      if (b.stream === 'thinking') break;
      const lines = b.text.split('\n');
      for (const l of lines) if (l.trim()) pushBounded(a.outputTail, b.stream === 'stderr' ? `! ${l}` : l, OUTPUT_TAIL);
      break;
    }
    case 'tool.started': {
      const a = s.agents[b.agentId];
      if (!a) break;
      a.toolCount++;
      a.lastActivity = e.ts;
      pushBounded(a.toolCalls, { id: b.toolId, name: b.name, input: b.input, startedAt: e.ts }, TOOL_TAIL);
      const program = classifyCompute(b.name, b.input);
      const t = s.tasks[a.taskId];
      if (program && t) {
        const c = ((t.computes ??= {})[program] ??= { program, runs: 0, running: 0, ok: 0, failed: 0, lastInput: '', lastAt: 0 });
        c.runs++;
        c.running++;
        c.lastInput = b.input.slice(0, 300);
        c.lastAt = e.ts;
        (t.computeOpen ??= {})[b.toolId] = { program, agentId: a.id };
      }
      break;
    }
    case 'tool.finished': {
      const a = s.agents[b.agentId];
      if (!a) break;
      a.lastActivity = e.ts;
      const t = s.tasks[a.taskId];
      const open = t?.computeOpen?.[b.toolId];
      if (t && open) {
        const c = t.computes![open.program];
        c.running = Math.max(0, c.running - 1);
        if (b.ok) c.ok++;
        else c.failed++;
        delete t.computeOpen![b.toolId];
      }
      const tc = a.toolCalls.find((x) => x.id === b.toolId);
      if (tc) {
        tc.ok = b.ok;
        tc.output = b.output;
        tc.endedAt = e.ts;
      }
      break;
    }
    case 'usage': {
      const a = s.agents[b.agentId];
      const prev = a ? a.usage : emptyUsage();
      const delta = diffUsage(b.usage, prev);
      if (a) a.usage = { ...b.usage };
      const t = s.tasks[b.taskId];
      if (t) addUsage(t.usage, delta);
      addUsage(s.totals, delta);
      const pu = (s.usageByProvider[b.provider] ??= emptyUsage());
      addUsage(pu, delta);
      const tokens = billableTokens(delta);
      if (a && a.attempt > 1) s.totals.retryTokens += tokens;
      if (a && a.role === 'reviewer') s.totals.reviewTokens += tokens;
      break;
    }
    case 'quota':
      s.quotas[`${b.provider}:${b.window}`] = { provider: b.provider, window: b.window, utilization: b.utilization, resetsAt: b.resetsAt, status: b.status, observedAt: e.ts };
      break;
    case 'artifact.created': {
      const { type: _t, ...art } = b;
      s.artifacts[b.id] = { ...art, createdAt: e.ts };
      const t = s.tasks[b.taskId];
      if (t && !t.artifactIds.includes(b.id)) t.artifactIds.push(b.id);
      // The root's synthesis report is the run's final report.
      if (b.kind === 'report' && t?.kind === 'synthesize' && t.parentTaskId && t.parentTaskId === s.run.rootTaskId) s.run.finalArtifactId = b.id;
      break;
    }
    case 'review.verdict': {
      const { type: _t, ...v } = b;
      s.reviews[b.id] = { ...v, createdAt: e.ts };
      const t = s.tasks[b.targetTaskId];
      if (t) {
        t.reviewIds.push(b.id);
        if (b.verdict === 'pass') t.verified = true;
      }
      signal(s, b.reviewerAgentId, t?.agentIds.at(-1), 'review', e.seq);
      break;
    }
    case 'delegation.requested':
    case 'delegation.decided':
      break; // recorded in the log; state changes arrive as task/agent events
    case 'approval.requested':
      s.approvals[b.id] = { id: b.id, kind: b.kind, description: b.description, taskId: b.taskId, payload: b.payload, status: 'pending', createdAt: e.ts };
      break;
    case 'approval.resolved': {
      const ap = s.approvals[b.approvalId];
      if (ap) {
        ap.status = b.approved ? 'approved' : 'denied';
        ap.resolvedAt = e.ts;
      }
      break;
    }
    case 'limit.hit':
      s.limitEvents.push({ limit: b.limit, detail: b.detail, ts: e.ts });
      break;
    case 'duplicate.rejected':
      s.totals.duplicateRejected++;
      break;
    case 'error':
    case 'recovery':
      break;
  }
  return s;
}

export function foldEvents(events: Iterable<EventEnvelope>, from?: RunState, uptoSeq = Infinity): RunState {
  const s = from ?? initialState();
  for (const e of events) {
    if (e.seq <= s.lastSeq) continue; // idempotent: replays never double-apply
    if (e.seq > uptoSeq) break;
    applyEvent(s, e);
  }
  return s;
}

/** Key-order-independent form of a state, for equality checks (replay vs persisted). */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as any)[k] !== undefined)
        .map((k) => [k, canonicalize((v as any)[k])]),
    );
  return v;
}
