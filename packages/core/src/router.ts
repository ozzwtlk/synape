import { familyOf } from './models.ts';
import type { CostBreakdown, ModelProfile, RouteCandidate, RoutingDecision, Task, TaskCategory } from './types.ts';

/** Aggregated local performance history for one (model, category) pair. */
export interface ModelStats {
  successes: number;
  failures: number;
  meanTokens?: number;
  meanDurationMs?: number;
}

export interface RouterContext {
  models: ModelProfile[];
  stats: (modelId: string, category: TaskCategory) => ModelStats | undefined;
  /** Providers currently at their concurrency cap. */
  saturated?: Set<string>;
  /** Latest observed subscription utilization per provider (0..1). */
  quotaUtilization?: Record<string, number>;
  allowedProviders?: string[];
  maxRetries: number;
  qualityBias: number;
  /** For reviews: the author's model; reviewer must differ (and prefer other family). */
  authorModelId?: string;
}

const BASE_TOKENS: Record<TaskCategory, number> = {
  extraction: 18_000,
  analysis: 45_000,
  coding: 90_000,
  reasoning: 60_000,
  writing: 40_000,
  research: 90_000,
  review: 35_000,
  planning: 25_000,
};

/** Routing refused because the capable models are out of quota (wait, don't downgrade). */
export class QuotaBlockedError extends Error {}

/** Cost multiplier for a reviewer from the author's own model family. */
export const SAME_FAMILY_REVIEW_PENALTY = 1.5;

/**
 * Cold-start priors are guesses: a model within this margin of the quality bar
 * stays eligible (its expected retry/escalation cost still counts), so a few
 * hundredths of assumed skill can't force work onto a far more expensive model.
 */
export const COLD_START_SLACK = 0.03;

/** Prior weight of cold-start belief, in pseudo-observations. */
const PRIOR_STRENGTH = 6;

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function estimateTokens(task: Pick<Task, 'category' | 'complexity'>, stats?: ModelStats): number {
  const prior = BASE_TOKENS[task.category] * (0.5 + 0.35 * task.complexity);
  if (stats?.meanTokens && stats.successes + stats.failures >= 3) {
    const n = stats.successes + stats.failures;
    const w = n / (n + 3);
    return Math.round(prior * (1 - w) + stats.meanTokens * w);
  }
  return Math.round(prior);
}

/** Capability needed for a task, 0..1. */
export const requiredSkill = (complexity: number) => 0.25 + 0.13 * complexity;

export function priorSuccess(m: ModelProfile, category: TaskCategory, complexity: number): number {
  const skill = m.skill[category] ?? 0.5;
  return clamp(sigmoid(7 * (skill - requiredSkill(complexity)) + 0.6), 0.03, 0.97);
}

/** Beta posterior mean and an approximate 10th-percentile lower bound. */
export function posterior(prior: number, st?: ModelStats) {
  const a = prior * PRIOR_STRENGTH + (st?.successes ?? 0);
  const b = (1 - prior) * PRIOR_STRENGTH + (st?.failures ?? 0);
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return { mean, low: clamp(mean - 1.28 * sd, 0, 1), high: clamp(mean + 1.28 * sd, 0, 1), samples: (st?.successes ?? 0) + (st?.failures ?? 0) };
}

export function requiredSuccess(criticality: number, qualityBias: number) {
  return clamp(0.45 + 0.1 * criticality + 0.15 * qualityBias, 0.4, 0.9);
}

function execCost(m: ModelProfile, tokens: number) {
  return (tokens / 1000) * m.ruPer1kTokens;
}

/**
 * Route a task: pick the model with the lowest expected total cost per
 * verified result among models that clear the task's quality bar.
 *
 *   E[total] = execution + E[retry] + verification + E[escalation]
 */
export function route(task: Task, ctx: RouterContext): RoutingDecision {
  const assumptions: string[] = [
    'Costs in Resource Units (RU): relative quota pressure per 1k tokens, not money (subscription billing).',
    `Cold-start success priors from catalog skill scores, weighted as ${PRIOR_STRENGTH} pseudo-observations.`,
  ];
  // A model the user pinned is allowed even if its provider isn't in the run's list.
  const allowed = (m: ModelProfile) => m.id === task.pinnedModel || !ctx.allowedProviders || ctx.allowedProviders.includes(m.provider);
  const pool = ctx.models.filter((m) => m.available && allowed(m) && !m.preworkOnly);
  const author = ctx.authorModelId ? ctx.models.find((m) => m.id === ctx.authorModelId) : undefined;
  const otherFamilyAvailable = author ? pool.some((m) => familyOf(m.provider) !== familyOf(author.provider)) : false;
  const needP = requiredSuccess(task.criticality, ctx.qualityBias);
  const reviewNeeded = task.kind !== 'review' && task.verification !== 'none';

  // Cheapest plausible reviewer cost, used as the verification term.
  const reviewCostFor = (authorM: ModelProfile, tokens: number) => {
    if (!reviewNeeded) return 0;
    const reviewTokens = Math.round(tokens * 0.4);
    const reviewers = pool.filter((r) => r.id !== authorM.id);
    const viable = reviewers.filter((r) => priorSuccess(r, 'review', task.complexity) >= 0.6);
    const set = viable.length ? viable : reviewers;
    if (!set.length) return 0;
    const crossExists = pool.some((x) => familyOf(x.provider) !== familyOf(authorM.provider));
    const premium = (r: ModelProfile) => (crossExists && familyOf(r.provider) === familyOf(authorM.provider) ? SAME_FAMILY_REVIEW_PENALTY : 1);
    return Math.min(...set.map((r) => execCost(r, reviewTokens) * premium(r)));
  };

  const candidates: RouteCandidate[] = ctx.models.filter(allowed).map((m) => {
    const st = ctx.stats(m.id, task.category);
    const prior = priorSuccess(m, task.category, task.complexity);
    const post = posterior(prior, st);
    const tokens = estimateTokens(task, st);
    let penalty = 1;
    const q = ctx.quotaUtilization?.[m.provider];
    if (q !== undefined && q > 0.7) penalty *= 1 + (q - 0.7) * 3;
    if (ctx.saturated?.has(m.provider)) penalty *= 1.15;
    // Independence: a reviewer from another model family is preferred, but a
    // different model of the same family is allowed at a premium rather than
    // forcing every review onto the other (possibly far more expensive) provider.
    const sameFamily = !!author && otherFamilyAvailable && familyOf(m.provider) === familyOf(author.provider);
    if (sameFamily) penalty *= SAME_FAMILY_REVIEW_PENALTY;
    const exec = execCost(m, tokens) * penalty;
    const p = post.mean;
    let retry = 0;
    for (let i = 1; i <= ctx.maxRetries; i++) retry += exec * (1 - p) ** i;
    const verification = reviewCostFor(m, tokens);
    const stronger = pool.filter((x) => x.tier > m.tier).sort((a, b) => execCost(a, tokens) - execCost(b, tokens))[0];
    const escalation = stronger ? (1 - p) ** (ctx.maxRetries + 1) * execCost(stronger, tokens) : 0;
    const expected: CostBreakdown = {
      execution: exec,
      expectedRetry: retry,
      verification,
      expectedEscalation: escalation,
      total: exec + retry + verification + escalation,
      unit: 'RU',
    };
    let rejectedBecause: string | undefined;
    if (task.pinnedModel) {
      // User's explicit choice wins over every routing gate except availability.
      if (m.id !== task.pinnedModel) rejectedBecause = `task pinned to ${task.pinnedModel} by user`;
      else if (!m.available) rejectedBecause = m.unavailableReason ?? 'provider unavailable';
      else if (q !== undefined && q > 0.95) rejectedBecause = `quota ${Math.round(q * 100)}% used`;
    } else if (!m.available) rejectedBecause = m.unavailableReason ?? 'provider unavailable';
    else if (m.preworkOnly) rejectedBecause = 'pre-work only (used while subscriptions are out of quota)';
    else if (m.tier < task.minTier) rejectedBecause = `below escalation floor (tier ${task.minTier})`;
    else if (task.excludedModels.includes(m.id)) rejectedBecause = 'failed this task before';
    else if (author && m.id === author.id) rejectedBecause = 'is the author (no self-review)';
    else if (q !== undefined && q > 0.95) rejectedBecause = `quota ${Math.round(q * 100)}% used`;
    else if (tokens * 0.6 > m.contextWindow) rejectedBecause = 'context window too small';
    // Cold start: gate on the prior. With evidence, exclude only when it is confident:
    // the optimistic (90th pct) bound is below the bar.
    // Expected cost still uses the mean, so early failures raise the retry term without being conclusive.
    else if ((post.samples ? post.high : p + COLD_START_SLACK) < needP) rejectedBecause = `P(success) ${p.toFixed(2)} (≤${post.high.toFixed(2)}) < required ${needP.toFixed(2)}`;
    return { modelId: m.id, pSuccess: p, pSuccessLow: post.low, samples: post.samples, expected, eligible: !rejectedBecause, rejectedBecause };
  });

  let eligible = candidates.filter((c) => c.eligible);
  let fallback = false;
  if (!eligible.length) {
    // Nothing clears the bar: take a most capable usable model; among near-equals
    // (within 0.05 P(success)) the cheapest, so a tie never defaults to the dearest provider.
    fallback = true;
    const usable = task.pinnedModel ? [] : candidates.filter((c) => !c.rejectedBecause || c.rejectedBecause.startsWith('P(success)'));
    const best = Math.max(...usable.map((c) => c.pSuccess));
    // A clearly stronger model exists but is out of quota: wait for it rather than
    // hand hard work to a weak model (the caller turns this into a wait + pre-work).
    const blocked = candidates.filter((c) => c.rejectedBecause?.startsWith('quota') && c.pSuccess > best + 0.05);
    if (blocked.length) throw new QuotaBlockedError(`stronger models are out of quota (${blocked.map((c) => labelOf(ctx.models, c.modelId)).join(', ')})`);
    const near = usable.filter((c) => c.pSuccess >= best - 0.05).sort((a, b) => a.expected.total - b.expected.total);
    eligible = near.length ? [near[0]] : [];
    if (eligible.length) assumptions.push('No model met the quality threshold; selected the cheapest of the most capable available models.');
  }
  if (!eligible.length) throw new Error(task.pinnedModel ? `Pinned model ${task.pinnedModel} is not available (${candidates.find((c) => c.modelId === task.pinnedModel)?.rejectedBecause ?? 'unknown model'})` : `No available model can run task "${task.title}"`);

  eligible.sort((a, b) => a.expected.total - b.expected.total || b.pSuccess - a.pSuccess);
  const pick = eligible[0];
  const m = ctx.models.find((x) => x.id === pick.modelId)!;
  const tokens = estimateTokens(task, ctx.stats(m.id, task.category));
  candidates.sort((a, b) => (a.eligible === b.eligible ? a.expected.total - b.expected.total : a.eligible ? -1 : 1));

  const cheaperRejected = candidates
    .filter((c) => !c.eligible && c.expected.total < pick.expected.total)
    .slice(0, 2)
    .map((c) => `${labelOf(ctx.models, c.modelId)} (${c.rejectedBecause})`);
  const parts = [
    `${m.label} for ${task.category} c${task.complexity}/crit${task.criticality}`,
    `P(success)≈${pick.pSuccess.toFixed(2)} (${pick.samples ? `${pick.samples} past runs` : 'prior only'}, need ≥${needP.toFixed(2)})`,
    `E[cost] ${Math.round(pick.expected.total)} RU = exec ${Math.round(pick.expected.execution)} + retry ${Math.round(pick.expected.expectedRetry)} + review ${Math.round(pick.expected.verification)} + escalation ${Math.round(pick.expected.expectedEscalation)}`,
  ];
  if (task.pinnedModel) parts.push('model chosen by user (routing bypassed)');
  else if (cheaperRejected.length) parts.push(`cheaper rejected: ${cheaperRejected.join('; ')}`);
  if (author) {
    const same = familyOf(m.provider) === familyOf(author.provider);
    parts.push(`independent of author ${labelOf(ctx.models, author.id)}${same && otherFamilyAvailable ? ` (same family, cheaper than cross-family even with ×${SAME_FAMILY_REVIEW_PENALTY} premium)` : ''}`);
  }
  if (fallback) parts.push('fallback: no model met the bar');

  return {
    modelId: m.id,
    provider: m.provider,
    model: m.model,
    effort: m.effort,
    explanation: parts.join('\n'),
    candidates,
    assumptions,
    estTokens: tokens,
  };
}

const labelOf = (models: ModelProfile[], id: string) => models.find((m) => m.id === id)?.label ?? id;
