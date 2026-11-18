import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterEvent, AgentRunSpec, ErrorClass, ProviderAdapter, ProviderInfo } from './types.ts';
import { runChatAgent } from './local.ts';

/**
 * Free frontier models through a self-hosted FreeLLMAPI gateway
 * (github.com/tashfeenahmed/freellmapi): one OpenAI-compatible endpoint in
 * front of many providers' free tiers, with failover between them.
 *
 * Synape uses it only for PRE-WORK: when subscription models are out of quota
 * and the local model is not capable enough, free models prepare a head start
 * (sources located, facts extracted, approach and draft) that the subscription
 * model checks and finishes after the reset. It never replaces their work.
 */

export interface FreeConfig {
  url: string;
  apiKey?: string;
  /** Gateway model: "auto:smart" ranks the strongest enabled free models first. */
  model: string;
  enabled: boolean;
  /** Context window assumed for compaction (the gateway routes to models of varying size). */
  ctx: number;
}

export function freeConfig(dataDir: string): FreeConfig {
  let saved: Partial<FreeConfig> = {};
  try {
    saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).freellm ?? {};
  } catch {}
  const env = process.env;
  return {
    url: env.SYNAPE_FREELLM_URL ?? saved.url ?? 'http://127.0.0.1:3001',
    apiKey: env.SYNAPE_FREELLM_KEY ?? saved.apiKey,
    model: env.SYNAPE_FREELLM_MODEL ?? saved.model ?? 'auto:smart',
    enabled: env.SYNAPE_FREELLM_ENABLED ? env.SYNAPE_FREELLM_ENABLED !== '0' : (saved.enabled ?? true),
    ctx: Number(env.SYNAPE_FREELLM_CTX ?? saved.ctx ?? 128_000),
  };
}

export const FREE_SKILLS = `You are a pre-work agent running on a free model. A stronger model will do the actual task later and will rely on your notes, so precision beats volume.

Rules:
- Read the real sources with the tools; never guess file contents. Cite every fact with file:line or (p. N).
- Copy equations, numbers and units exactly. Mark anything you infer as "inferred".
- Your draft is a starting point, not a result: label it UNVERIFIED and say where you are unsure.
- Keep the whole answer under ~1500 words. Lists over prose.`;

export class FreeLLMAdapter implements ProviderAdapter {
  id = 'freellm';
  private readonly cfg: () => FreeConfig;
  constructor(cfg: () => FreeConfig) {
    this.cfg = cfg;
  }

  static forDataDir(dataDir: string) {
    return new FreeLLMAdapter(() => freeConfig(dataDir));
  }

  async detect(): Promise<ProviderInfo> {
    const c = this.cfg();
    const base = { id: this.id, label: 'Free models (FreeLLMAPI)', billing: 'free' as const };
    if (!c.enabled) return { ...base, available: false, reason: 'pre-work with free models is switched off' };
    if (!c.apiKey) return { ...base, available: false, reason: `no FreeLLMAPI key: set it in Fleet (gateway at ${c.url})` };
    try {
      const res = await fetch(`${c.url.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models?available=true`, { headers: { authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(4000) });
      if (res.status === 401 || res.status === 403) return { ...base, available: false, reason: 'FreeLLMAPI rejected the key' };
      if (!res.ok) return { ...base, available: false, reason: `FreeLLMAPI HTTP ${res.status}` };
      const body = (await res.json()) as { data?: { id: string; execution_status?: string }[] };
      const ready = (body.data ?? []).filter((m) => !m.execution_status || m.execution_status === 'ready');
      if (!ready.length) return { ...base, available: false, reason: 'FreeLLMAPI has no ready models (add provider keys in its dashboard)' };
      return { ...base, available: true, version: `${ready.length} free models ready`, auth: `gateway ${c.url} · ${c.model}` };
    } catch (e) {
      return { ...base, available: false, reason: `no FreeLLMAPI gateway at ${c.url} (${(e as Error).message})` };
    }
  }

  async *run(spec: AgentRunSpec): AsyncIterable<AdapterEvent> {
    const c = this.cfg();
    if (!c.enabled || !c.apiKey) {
      yield { kind: 'final', ok: false, text: '', error: 'FreeLLMAPI not configured', errorClass: 'provider' };
      return;
    }
    yield* runChatAgent(spec, {
      url: c.url,
      apiKey: c.apiKey,
      model: spec.model && spec.model !== 'auto' ? spec.model : c.model,
      ctx: c.ctx,
      label: 'free',
      skills: FREE_SKILLS,
      sessionPrefix: 'free',
      // Gateway quota exhausted or every upstream rate-limited: a provider problem, not the task's fault.
      classify: (e: Error & { status?: number }): ErrorClass => (e.status === 429 || e.status === 402 || (e.status ?? 0) >= 500 ? 'provider' : /context|too long|exceed/i.test(e.message) ? 'task' : 'provider'),
      onHeaders: (h) => {
        const v = h['x-routed-via'];
        return typeof v === 'string' ? decodeURIComponent(v) : undefined;
      },
    });
  }
}
