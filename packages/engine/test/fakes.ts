// TEST-ONLY scripted provider. Never registered by the application.
import type { AdapterEvent, AgentRunSpec, ProviderAdapter, ProviderInfo } from '../src/adapters/types.ts';

export type Script = (spec: AgentRunSpec, n: number) => { text?: string; structured?: unknown; ok?: boolean; error?: string; errorClass?: 'quota' | 'provider' | 'task'; delayMs?: number; tokens?: number };

export class ScriptedAdapter implements ProviderAdapter {
  calls: AgentRunSpec[] = [];
  id: string;
  script: Script;
  constructor(id: string, script: Script) {
    this.id = id;
    this.script = script;
  }
  async detect(): Promise<ProviderInfo> {
    return { id: this.id, label: this.id, available: true, billing: 'subscription' };
  }
  async *run(spec: AgentRunSpec): AsyncIterable<AdapterEvent> {
    this.calls.push(spec);
    const r = this.script(spec, this.calls.length);
    yield { kind: 'session', sessionId: `sess-${spec.agentId}` };
    yield { kind: 'tool_start', id: 't1', name: 'Read', input: '{}' };
    if (r.delayMs && !spec.signal.aborted) {
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, r.delayMs);
        spec.signal.addEventListener('abort', () => {
          clearTimeout(t);
          ok();
        });
      });
    }
    yield { kind: 'tool_end', id: 't1', ok: true, output: 'ok' };
    const tok = r.tokens ?? 1000;
    yield { kind: 'usage', usage: { inputTokens: tok, outputTokens: tok / 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costBasis: 'unavailable' } };
    if (spec.signal.aborted) {
      yield { kind: 'final', ok: false, text: '', error: 'cancelled', errorClass: 'cancelled' };
      return;
    }
    if (r.text) yield { kind: 'text', text: r.text };
    yield { kind: 'final', ok: r.ok ?? true, text: r.text ?? '', structured: r.structured, error: r.error, errorClass: r.errorClass };
  }
}

export const plannedTask = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  objective: `Do the ${key} thing with unique words ${key}${key}${key}`,
  kind: 'work',
  category: 'analysis',
  complexity: 2,
  criticality: 2,
  deps: [],
  acceptance: ['done'],
  verification: 'none',
  permission: 'read',
  scope: [],
  ...extra,
});

export const isPlan = (s: AgentRunSpec) => !!s.jsonSchema && 'tasks' in ((s.jsonSchema as any).properties ?? {});
export const isReview = (s: AgentRunSpec) => !!s.jsonSchema && 'verdict' in ((s.jsonSchema as any).properties ?? {});
export const isSynth = (s: AgentRunSpec) => /final report for the user|Synthesize the results/.test(s.prompt);
