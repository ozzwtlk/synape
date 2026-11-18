import { describe, it, expect } from 'vitest';
import { BUILTIN_MODELS, DEFAULT_PROVIDER_WEIGHT, QuotaBlockedError, route, findCycle, topoOrder, type ModelProfile, type Task } from '../src/index.ts';

const models: ModelProfile[] = BUILTIN_MODELS.map((m) => ({ ...m, available: true }));
const task = (p: Partial<Task>): Task =>
  ({
    id: 't',
    title: 't',
    objective: 'o',
    kind: 'work',
    category: 'analysis',
    complexity: 2,
    criticality: 2,
    acceptance: [],
    verification: 'none',
    permission: 'read',
    depth: 1,
    deps: [],
    status: 'ready',
    attempts: 0,
    agentIds: [],
    minTier: 1,
    excludedModels: [],
    artifactIds: [],
    reviewIds: [],
    verified: false,
    usage: {} as any,
    createdAt: 0,
    ...p,
  }) as Task;
const ctx = { models, stats: () => undefined, maxRetries: 2, qualityBias: 0.5 };
const tier = (id: string) => models.find((m) => m.id === id)!.tier;

describe('router', () => {
  it('uses a light model for routine extraction', () => {
    const d = route(task({ category: 'extraction', complexity: 1, criticality: 1 }), ctx);
    expect(tier(d.modelId)).toBe(1);
  });

  it('uses a strong model for hard reasoning', () => {
    const d = route(task({ category: 'reasoning', complexity: 5, criticality: 3 }), ctx);
    expect(tier(d.modelId)).toBeGreaterThanOrEqual(3);
  });

  it('prefers a coding-strong model for coding', () => {
    const d = route(task({ category: 'coding', complexity: 3 }), ctx);
    expect(d.provider).toBe('codex');
  });

  it('assigns a reviewer from the other model family', () => {
    const d = route(task({ kind: 'review', category: 'review', complexity: 3 }), { ...ctx, authorModelId: 'codex:gpt-6.1-sol@medium' });
    expect(d.provider).toBe('claude-code');
    const d2 = route(task({ kind: 'review', category: 'review', complexity: 3 }), { ...ctx, authorModelId: 'claude-code:sonnet' });
    expect(d2.provider).toBe('codex');
  });

  it('respects the escalation floor and exclusions', () => {
    const d = route(task({ category: 'extraction', complexity: 1, minTier: 3, excludedModels: ['claude-code:opus'] }), ctx);
    expect(tier(d.modelId)).toBeGreaterThanOrEqual(3);
    expect(d.modelId).not.toBe('claude-code:opus');
  });

  it('learns from history: a model that keeps failing loses the route', () => {
    const base = route(task({ category: 'extraction', complexity: 2 }), ctx);
    const failing = route(task({ category: 'extraction', complexity: 2 }), { ...ctx, stats: (m: string) => (m === base.modelId ? { successes: 1, failures: 12 } : undefined) });
    expect(failing.modelId).not.toBe(base.modelId);
  });

  it('small samples do not dominate the prior', () => {
    const base = route(task({ category: 'analysis', complexity: 3 }), ctx);
    const one = route(task({ category: 'analysis', complexity: 3 }), { ...ctx, stats: (m: string) => (m === base.modelId ? { successes: 0, failures: 1 } : undefined) });
    // One failure raises expected cost but does not make the model ineligible.
    expect(one.candidates.find((c) => c.modelId === base.modelId)!.eligible).toBe(true);
    const many = route(task({ category: 'analysis', complexity: 3 }), { ...ctx, stats: (m: string) => (m === base.modelId ? { successes: 1, failures: 15 } : undefined) });
    expect(many.candidates.find((c) => c.modelId === base.modelId)!.eligible).toBe(false);
  });

  it('explains its decision and includes a cost breakdown', () => {
    const d = route(task({ category: 'coding', complexity: 3, verification: 'review' }), ctx);
    expect(d.explanation).toMatch(/P\(success\)/);
    const pick = d.candidates.find((c) => c.modelId === d.modelId)!;
    expect(pick.expected.verification).toBeGreaterThan(0);
    expect(pick.expected.total).toBeCloseTo(pick.expected.execution + pick.expected.expectedRetry + pick.expected.verification + pick.expected.expectedEscalation);
  });

  describe('with default provider quota weights (as the engine applies them)', () => {
    const weighted = models.map((m) => ({ ...m, ruPer1kTokens: m.ruPer1kTokens * (DEFAULT_PROVIDER_WEIGHT[m.provider] ?? 1) }));
    const wctx = { ...ctx, models: weighted.map((m) => ({ ...m, available: m.id !== 'claude-code:fable' })) };

    it('keeps routine and mid-difficulty work off Codex', () => {
      for (const category of ['extraction', 'analysis', 'coding', 'reasoning', 'writing', 'research'] as const)
        for (const complexity of [1, 2, 3]) {
          const d = route(task({ category, complexity, verification: 'review' }), wctx);
          expect(d.provider, `${category} c${complexity}`).not.toBe('codex');
        }
    });

    it('sends bulky low-difficulty reading to the local model', () => {
      expect(route(task({ category: 'extraction', complexity: 2 }), wctx).provider).toBe('local');
      expect(route(task({ category: 'analysis', complexity: 2 }), wctx).provider).toBe('local');
    });

    it('still uses Codex when it is really needed', () => {
      expect(route(task({ category: 'coding', complexity: 5, criticality: 3 }), wctx).provider).toBe('codex');
      // Claude near its 5-hour limit: Codex takes over.
      expect(route(task({ category: 'analysis', complexity: 3 }), { ...wctx, quotaUtilization: { 'claude-code': 0.97 } }).provider).not.toBe('claude-code');
    });

    it('lets a cheaper same-family model review rather than an expensive cross-family one', () => {
      const d = route(task({ kind: 'review', category: 'review', complexity: 3 }), { ...wctx, authorModelId: 'claude-code:sonnet' });
      expect(d.provider).toBe('claude-code');
      expect(d.modelId).not.toBe('claude-code:sonnet');
      expect(d.explanation).toMatch(/same family/);
    });
  });

  it('hard work waits for strong models that are out of quota instead of dropping to a weak one', () => {
    const t = task({ category: 'reasoning', complexity: 5, criticality: 3 });
    expect(() => route(t, { ...ctx, quotaUtilization: { 'claude-code': 1, codex: 1 } })).toThrow(QuotaBlockedError);
    // Light work still goes to whatever capable model has quota.
    expect(route(task({ category: 'extraction', complexity: 1 }), { ...ctx, quotaUtilization: { 'claude-code': 1, codex: 1 } }).provider).toBe('local');
  });

  it('a pinned model is allowed even outside the run provider list', () => {
    const d = route(task({ pinnedModel: 'local:default' }), { ...ctx, allowedProviders: ['claude-code'] });
    expect(d.modelId).toBe('local:default');
  });

  it('when nothing clears the bar, prefers the cheaper of near-equal models', () => {
    const d = route(task({ category: 'reasoning', complexity: 5, criticality: 3 }), ctx);
    const top = Math.max(...d.candidates.filter((c) => !c.rejectedBecause || c.rejectedBecause.startsWith('P(')).map((c) => c.pSuccess));
    const near = d.candidates.filter((c) => c.pSuccess >= top - 0.05 && (!c.rejectedBecause || c.rejectedBecause.startsWith('P(')));
    expect(d.modelId).toBe(near.sort((a, b) => a.expected.total - b.expected.total)[0].modelId);
  });

  it('avoids providers near their quota limit', () => {
    const d = route(task({ category: 'analysis', complexity: 2 }), { ...ctx, quotaUtilization: { 'claude-code': 0.97 } });
    expect(d.provider).not.toBe('claude-code');
  });
});

describe('graph', () => {
  it('detects cycles', () => {
    const tasks = { a: { deps: ['b'] }, b: { deps: [] } };
    expect(findCycle(tasks, 'b', ['a'])).not.toBeNull();
    expect(findCycle(tasks, 'c', ['a'])).toBeNull();
    expect(() => topoOrder([{ key: 'x', deps: ['y'] }, { key: 'y', deps: ['x'] }])).toThrow(/cycle/);
  });
});
