import type { ModelProfile } from './types.ts';

/**
 * Built-in model catalog. Skill priors and Resource-Unit (RU) weights are
 * explicit, documented ASSUMPTIONS used for cold-start routing. They are
 * refined by local performance history (see router.ts). RU weights model
 * relative quota pressure on subscriptions; they are not prices.
 *
 * Availability is decided at runtime by provider detection, never assumed.
 */
export const BUILTIN_MODELS: Omit<ModelProfile, 'available'>[] = [
  {
    id: 'claude-code:haiku',
    provider: 'claude-code',
    model: 'haiku',
    label: 'Claude Haiku',
    billing: 'subscription',
    tier: 1,
    contextWindow: 200_000,
    skill: { extraction: 0.8, analysis: 0.55, coding: 0.5, reasoning: 0.35, writing: 0.6, research: 0.55, review: 0.5, planning: 0.45 },
    ruPer1kTokens: 1,
    latencyFactor: 0.5,
  },
  {
    id: 'claude-code:sonnet',
    provider: 'claude-code',
    model: 'sonnet',
    label: 'Claude Sonnet',
    billing: 'subscription',
    tier: 2,
    contextWindow: 1_000_000,
    skill: { extraction: 0.88, analysis: 0.78, coding: 0.78, reasoning: 0.65, writing: 0.82, research: 0.78, review: 0.75, planning: 0.75 },
    ruPer1kTokens: 3,
    latencyFactor: 0.8,
  },
  {
    id: 'claude-code:opus',
    provider: 'claude-code',
    model: 'opus',
    label: 'Claude Opus',
    billing: 'subscription',
    tier: 3,
    contextWindow: 1_000_000,
    skill: { extraction: 0.9, analysis: 0.88, coding: 0.86, reasoning: 0.82, writing: 0.9, research: 0.86, review: 0.88, planning: 0.88 },
    ruPer1kTokens: 5,
    latencyFactor: 1,
  },
  {
    id: 'claude-code:fable',
    provider: 'claude-code',
    model: 'claude-fable-5-2',
    label: 'Claude Fable',
    billing: 'subscription',
    tier: 4,
    contextWindow: 1_000_000,
    skill: { extraction: 0.92, analysis: 0.93, coding: 0.9, reasoning: 0.93, writing: 0.93, research: 0.9, review: 0.93, planning: 0.92 },
    ruPer1kTokens: 9,
    latencyFactor: 1.4,
    // Not included in every Claude plan: opt in from the Fleet panel.
    defaultEnabled: false,
  },
  {
    id: 'codex:gpt-6-luna@low',
    provider: 'codex',
    model: 'gpt-6-luna',
    effort: 'low',
    label: 'GPT-6 Luna · low',
    billing: 'subscription',
    tier: 1,
    contextWindow: 272_000,
    skill: { extraction: 0.78, analysis: 0.5, coding: 0.6, reasoning: 0.38, writing: 0.5, research: 0.45, review: 0.5, planning: 0.4 },
    ruPer1kTokens: 0.8,
    latencyFactor: 0.5,
  },
  {
    id: 'codex:gpt-6.1-sol@medium',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    label: 'GPT-6.1 Sol · medium',
    billing: 'subscription',
    tier: 2,
    contextWindow: 500_000,
    skill: { extraction: 0.85, analysis: 0.76, coding: 0.84, reasoning: 0.7, writing: 0.7, research: 0.7, review: 0.76, planning: 0.7 },
    ruPer1kTokens: 2.5,
    latencyFactor: 0.9,
  },
  {
    id: 'codex:gpt-6.1-sol@high',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    label: 'GPT-6.1 Sol · high',
    billing: 'subscription',
    tier: 3,
    contextWindow: 500_000,
    skill: { extraction: 0.87, analysis: 0.84, coding: 0.9, reasoning: 0.82, writing: 0.74, research: 0.78, review: 0.85, planning: 0.8 },
    ruPer1kTokens: 4,
    latencyFactor: 1.3,
  },
  {
    id: 'codex:gpt-6-astra@high',
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    label: 'GPT-6 Astra · high',
    billing: 'subscription',
    tier: 4,
    contextWindow: 272_000,
    skill: { extraction: 0.9, analysis: 0.92, coding: 0.92, reasoning: 0.93, writing: 0.8, research: 0.85, review: 0.93, planning: 0.88 },
    ruPer1kTokens: 8,
    latencyFactor: 1.6,
  },
  {
    // Local llama.cpp model (default: Qwen3.6-35B-A3B, 3B active). Haiku-class on
    // agentic coding (SWE-bench Verified 73.4 vs ~73) but slower per token and
    // weaker on hard reasoning; it costs no subscription quota, so the router sends
    // it the bulky, low-difficulty work (reading PDFs, extraction, summaries).
    // RU is a small nonzero "time/electricity" cost so ties go to faster models.
    id: 'local:default',
    provider: 'local',
    model: 'local',
    label: 'Local · Qwen3.6-35B-A3B',
    billing: 'local',
    tier: 1,
    contextWindow: 163_840, // default served context (see engine/src/local.ts)
    skill: { extraction: 0.8, analysis: 0.55, coding: 0.55, reasoning: 0.42, writing: 0.55, research: 0.5, review: 0.42, planning: 0.38 },
    ruPer1kTokens: 0.08,
    latencyFactor: 1.4,
  },
  {
    // Free frontier models behind a self-hosted FreeLLMAPI gateway ("auto:smart"
    // ranks the strongest enabled ones: DeepSeek, Kimi, GLM, Gemini, Qwen…).
    // Quality and capacity vary by the hour and prompts go to third-party free
    // tiers, so it is used only for pre-work while subscriptions are exhausted.
    id: 'freellm:auto',
    provider: 'freellm',
    model: 'auto:smart',
    label: 'Free frontier (FreeLLMAPI)',
    billing: 'free',
    tier: 2,
    contextWindow: 128_000,
    skill: { extraction: 0.8, analysis: 0.68, coding: 0.68, reasoning: 0.6, writing: 0.68, research: 0.65, review: 0.6, planning: 0.6 },
    ruPer1kTokens: 0.05,
    latencyFactor: 1.5,
    preworkOnly: true,
  },
];

/**
 * Quota-pressure multiplier per provider, applied on top of the catalog RU.
 * Codex agents burn far more tokens per task (long tool loops, big cached
 * re-reads) and its plan limits are much tighter, so a "cheap" Codex model
 * still drains its 5-hour window faster than a Claude model doing the same
 * work. At ×3 the router uses Codex only when no Claude/local model is good
 * enough, Claude's quota is nearly used up, or the user pins it.
 * Adjustable per provider in the Fleet panel (settings.json `providerWeight`).
 */
export const DEFAULT_PROVIDER_WEIGHT: Record<string, number> = { codex: 3 };

export const familyOf = (provider: string) => (provider === 'claude-code' ? 'anthropic' : provider === 'codex' ? 'openai' : provider);
