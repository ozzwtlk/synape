import type { EventEnvelope, ModelProfile, OutputFile, QuotaWindow, RunState } from '@synape/core';

export interface OutputsResponse {
  recorded: Record<string, OutputFile[]>;
  inferred: Record<string, OutputFile[]>;
  pdfs: OutputFile[];
  tex: { names: string[]; texFiles: string[]; mains: string[]; figures: { name: string; rel?: string; path?: string }[] };
}

/** URL of a run file (confined server-side); `thumb` renders a PDF's first page. */
export const fileUrl = (runId: string, path: string, thumb = false) => `/api/runs/${runId}/file?path=${encodeURIComponent(path)}${thumb ? '&thumb=1' : ''}`;

let token = '';
export let home = '';

export async function bootstrap() {
  const r = await fetch('/api/bootstrap');
  const b = await r.json();
  token = b.token;
  home = b.home;
  return b as { token: string; home: string; cwd: string };
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init?.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init?.method && init.method !== 'GET') headers['x-synape-token'] = token;
  const r = await fetch(path, { ...init, headers, body });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error);
  const ct = r.headers.get('content-type') ?? '';
  return (ct.includes('json') ? r.json() : r.text()) as Promise<T>;
}

export interface RunSummary {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProvidersResponse {
  providers: { id: string; label: string; available: boolean; reason?: string; version?: string; auth?: string; billing: string }[];
  models: ModelProfile[];
  freellm?: { url: string; model: string; enabled: boolean; hasKey: boolean };
  quotas: Record<string, QuotaWindow>;
  perf: { modelId: string; category: string; n: number; successes: number; meanTokens: number; meanDurationMs: number }[];
}

export interface RepoInfo {
  isRepo: boolean;
  root?: string;
  branch?: string;
  head?: string;
  dirty?: number;
  untracked?: number;
  remotes?: { name: string; url: string }[];
  ghAuthenticated?: boolean;
  userName?: string;
}

export const api = {
  runs: () => req<RunSummary[]>('/api/runs'),
  state: (id: string) => req<RunState>(`/api/runs/${id}/state`),
  events: (id: string, after = 0) => req<EventEnvelope[]>(`/api/runs/${id}/events?after=${after}`),
  agentLog: (id: string, agentId: string) => req<EventEnvelope[]>(`/api/runs/${id}/agents/${agentId}/log`),
  artifact: (id: string, artId: string) => req<string>(`/api/runs/${id}/artifacts/${artId}`),
  providers: () => req<ProvidersResponse>('/api/providers'),
  refreshProviders: () => req('/api/providers/refresh', { method: 'POST', json: {} }),
  createRun: (body: unknown) => req<{ runId: string }>('/api/runs', { method: 'POST', json: body }),
  message: (id: string, text: string, agentId?: string) => req(`/api/runs/${id}/messages`, { method: 'POST', json: { text, agentId } }),
  control: (id: string, action: 'pause' | 'resume' | 'cancel') => req(`/api/runs/${id}/control`, { method: 'POST', json: { action } }),
  task: (id: string, taskId: string, action: 'cancel' | 'retry') => req(`/api/runs/${id}/tasks/${taskId}/${action}`, { method: 'POST', json: {} }),
  setTaskModel: (id: string, taskId: string, modelId: string | null) => req(`/api/runs/${id}/tasks/${taskId}/model`, { method: 'POST', json: { modelId } }),
  setModelEnabled: (modelId: string, enabled: boolean) => req('/api/models', { method: 'POST', json: { modelId, enabled } }),
  resetQuota: (provider?: string) => req<{ cleared: number }>('/api/quota/reset', { method: 'POST', json: { provider } }),
  setFreeLLM: (p: { url?: string; apiKey?: string; model?: string; enabled?: boolean }) => req('/api/freellm', { method: 'POST', json: p }),
  setProviderWeight: (provider: string, weight: number) => req('/api/provider-weight', { method: 'POST', json: { provider, weight } }),
  approve: (id: string, approvalId: string, approved: boolean) => req(`/api/runs/${id}/approvals/${approvalId}`, { method: 'POST', json: { approved } }),
  git: (path: string) => req<RepoInfo>(`/api/git?path=${encodeURIComponent(path)}`),
  gitAction: (id: string, kind: string) => req(`/api/runs/${id}/git`, { method: 'POST', json: { kind } }),
  outputs: (id: string) => req<OutputsResponse>(`/api/runs/${id}/outputs`),
  fs: (path?: string) => req<{ path: string; parent: string | null; entries: string[] }>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
};

export function streamRun(id: string, after: number, onEvent: (e: EventEnvelope) => void, onStatus: (connected: boolean) => void) {
  let es: EventSource | null = null;
  let last = after;
  let closed = false;
  const open = () => {
    es = new EventSource(`/api/runs/${id}/stream?after=${last}`);
    es.onopen = () => onStatus(true);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as EventEnvelope;
      last = e.seq;
      onEvent(e);
    };
    es.onerror = () => {
      onStatus(false);
      es?.close();
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
