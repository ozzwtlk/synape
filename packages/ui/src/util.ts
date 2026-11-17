import type { Agent, RunState, Task } from '@synape/core';
import { billableTokens } from '@synape/core';

export const fmtTokens = (n?: number) => {
  if (n === undefined || Number.isNaN(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

export const fmtDuration = (ms?: number) => {
  if (ms === undefined || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export type Family = 'anthropic' | 'openai' | 'other';
export const familyOfProvider = (p?: string): Family => (p === 'claude-code' ? 'anthropic' : p === 'codex' ? 'openai' : 'other');

export const latestAgent = (s: RunState, t: Task): Agent | undefined => {
  for (let i = t.agentIds.length - 1; i >= 0; i--) {
    const a = s.agents[t.agentIds[i]];
    if (a && a.attempt > 0) return a;
  }
  return undefined;
};

export const isActive = (a?: Agent) => !!a && (a.status === 'running' || a.status === 'starting');

export const tokensOf = (u: { inputTokens: number; outputTokens: number; cacheWriteTokens: number }) => billableTokens(u as any);

export const modelLabel = (s: { models?: { id: string; label: string }[] } | undefined, id?: string) => s?.models?.find((m) => m.id === id)?.label ?? id ?? '';

export const KIND_LABEL: Record<string, string> = {
  plan: 'ORCHESTRATOR',
  orchestrate: 'SUB-ORCHESTRATOR',
  work: 'WORKER',
  review: 'REVIEW',
  synthesize: 'SYNTHESIS',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'waiting',
  ready: 'queued',
  running: 'running',
  awaiting_review: 'in review',
  delegated: 'delegating',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'needs approval',
};
