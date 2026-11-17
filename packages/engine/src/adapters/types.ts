import type { PermissionLevel, Usage } from '@synape/core';

export interface AgentRunSpec {
  agentId: string;
  prompt: string;
  systemPrompt?: string;
  model: string;
  effort?: string;
  cwd: string;
  permission: PermissionLevel;
  /** Additional readable directories. */
  extraDirs: string[];
  /** JSON Schema for a structured final answer. */
  jsonSchema?: object;
  resumeSessionId?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Scratch dir for adapter temp files (schemas, last-message files). */
  scratchDir: string;
}

export type AdapterEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'pid'; pid: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'tool_start'; id: string; name: string; input: string }
  | { kind: 'tool_end'; id: string; ok: boolean; output: string }
  /** Cumulative usage for this agent run so far. */
  | { kind: 'usage'; usage: Usage }
  | { kind: 'quota'; window: string; utilization?: number; resetsAt?: number; status?: string }
  | { kind: 'final'; ok: boolean; text: string; structured?: unknown; error?: string; errorClass?: ErrorClass };

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  version?: string;
  auth?: string;
  billing: 'subscription' | 'api' | 'local' | 'unknown';
}

export interface ProviderAdapter {
  id: string;
  detect(): Promise<ProviderInfo>;
  run(spec: AgentRunSpec): AsyncIterable<AdapterEvent>;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

/** quota = subscription/usage limit: wait for the reset, it's nobody's fault. */
export type ErrorClass = 'quota' | 'provider' | 'task' | 'timeout' | 'cancelled';

export const isUsageLimit = (msg: string) => /hit your .{0,30}limit|usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i.test(msg);

/** Best-effort "try again in 2 hours 5 minutes" → ms from now. */
export function retryAfterMs(msg: string): number | undefined {
  const m = msg.match(/(?:try again|retry|resets?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i);
  if (!m) return undefined;
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
    const k = u[0].toLowerCase();
    ms += Number(n) * (k === 'd' ? 864e5 : k === 'h' ? 36e5 : k === 'm' ? 6e4 : 1e3);
  }
  return ms || undefined;
}
