// Core domain types. Pure TypeScript, no runtime dependencies: shared by the
// engine (Node) and the UI (browser) so both fold the same event stream with
// the same reducer.

export type ProviderId = 'claude-code' | 'codex' | (string & {});
export type BillingKind = 'subscription' | 'api' | 'local';

export type TaskKind =
  | 'plan' // orchestrator decomposes an objective into tasks
  | 'work' // a worker performs a bounded piece of work
  | 'orchestrate' // a sub-orchestrator plans + manages a sub-objective
  | 'review' // independent verification of another task's output
  | 'synthesize'; // fan-in: combine validated results

export type TaskCategory =
  | 'extraction' // pull structured facts out of material
  | 'analysis' // understand / compare / assess
  | 'coding' // implement or modify software
  | 'reasoning' // hard math, derivations, difficult judgement
  | 'writing' // prose, documentation, manuscripts
  | 'research' // literature / web research
  | 'review' // verification
  | 'planning'; // decomposition

export type TaskStatus =
  | 'pending' // waiting on dependencies
  | 'ready' // dependencies met, waiting for a slot
  | 'running'
  | 'awaiting_review' // output exists, independent review pending
  | 'delegated' // promoted to orchestrate; waiting on children
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'; // needs approval / budget

export type VerificationPolicy = 'none' | 'review' | 'crosscheck';

/** Permission levels, ordered. A task may never exceed the run's ceiling. */
export const PERMISSION_LEVELS = ['read', 'write', 'execute', 'network', 'external'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const permissionRank = (p: PermissionLevel) => PERMISSION_LEVELS.indexOf(p);

export type AgentRole = 'orchestrator' | 'sub_orchestrator' | 'worker' | 'reviewer' | 'synthesizer';
export type AgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type RunStatus = 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Limits {
  maxDepth: number; // maximum delegation depth (root orchestrator = 0)
  maxConcurrentAgents: number;
  maxAgentsPerTask: number; // attempts + reviews for one task
  maxTotalAgents: number; // hard cap on spawns per run
  maxRetries: number;
  maxTasks: number; // cap on dynamically created tasks
  taskTimeoutMs: number;
  providerConcurrency: Record<string, number>;
}

export interface Budgets {
  /** Total tokens (input + output, excluding cache reads) across the run. */
  maxTokens?: number;
  /** USD for API-billed calls only. Subscription usage is not priced. */
  maxApiUsd?: number;
  /** Per-task token ceiling. */
  maxTaskTokens?: number;
}

export interface RunConfig {
  limits: Limits;
  budgets: Budgets;
  /** Highest permission any agent in this run may get without approval. */
  permissionCeiling: PermissionLevel;
  /** Extra directories agents may read (e.g. a shared tool installation or dataset). */
  extraDirs: string[];
  /** Providers allowed in this run (subset of those available). */
  providers?: string[];
  /** Routing preference: 0 = cheapest viable, 1 = most reliable. */
  qualityBias: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 2,
  maxConcurrentAgents: 6,
  maxAgentsPerTask: 5,
  maxTotalAgents: 40,
  maxRetries: 2,
  maxTasks: 40,
  taskTimeoutMs: 30 * 60_000,
  providerConcurrency: { 'claude-code': 4, codex: 3 },
};

export const DEFAULT_CONFIG: RunConfig = {
  limits: DEFAULT_LIMITS,
  budgets: { maxTokens: 3_000_000 },
  permissionCeiling: 'read',
  extraDirs: [],
  qualityBias: 0.5,
};

export interface ModelProfile {
  /** Stable id: `${provider}:${model}[@effort]` */
  id: string;
  provider: ProviderId;
  model: string;
  effort?: string;
  label: string;
  billing: BillingKind;
  /** 1 = light, 2 = standard, 3 = strong, 4 = frontier */
  tier: 1 | 2 | 3 | 4;
  contextWindow: number;
  /** Prior capability per category, 0..1 (cold-start; refined by history). */
  skill: Partial<Record<TaskCategory, number>>;
  /**
   * Relative resource weight per 1k tokens, in normalized Resource Units.
   * For subscriptions this models quota pressure, NOT money.
   */
  ruPer1kTokens: number;
  /** USD per 1M input/output tokens, only for API billing. */
  usdPerMTok?: { input: number; output: number };
  /** Typical seconds per task relative to baseline 1.0 */
  latencyFactor: number;
  available: boolean;
  unavailableReason?: string;
}

export interface CostBreakdown {
  execution: number;
  expectedRetry: number;
  verification: number;
  expectedEscalation: number;
  total: number;
  unit: 'RU' | 'USD';
}

export interface RouteCandidate {
  modelId: string;
  pSuccess: number;
  pSuccessLow: number; // lower credible bound
  samples: number; // historical observations
  expected: CostBreakdown;
  eligible: boolean;
  rejectedBecause?: string;
}

export interface RoutingDecision {
  modelId: string;
  provider: ProviderId;
  model: string;
  effort?: string;
  explanation: string;
  candidates: RouteCandidate[];
  assumptions: string[];
  estTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** USD; for subscription runs this is an API-list-price *equivalent*. */
  costUsd?: number;
  costBasis: 'api-billed' | 'api-list-equivalent' | 'unavailable';
  durationMs?: number;
  contextWindow?: number;
  /** Largest single-turn prompt seen: proxy for context utilization. */
  peakContextTokens?: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costBasis: 'unavailable',
});

export interface TaskSpec {
  title: string;
  objective: string;
  kind: TaskKind;
  category: TaskCategory;
  /** 1 (trivial) .. 5 (research-grade) */
  complexity: number;
  /** 1 (low) .. 3 (high impact: claims, numbers, published code) */
  criticality: number;
  acceptance: string[];
  verification: VerificationPolicy;
  permission: PermissionLevel;
  /** Files / directories the task owns or should focus on. */
  scope?: string[];
  /** 'replan' marks a follow-up planning task that patches the live graph. */
  mode?: 'replan';
}

export interface Task extends TaskSpec {
  id: string;
  parentTaskId?: string; // owning orchestrate/plan task
  createdBy?: string; // agent id
  depth: number;
  deps: string[];
  status: TaskStatus;
  statusReason?: string;
  attempts: number;
  agentIds: string[];
  routing?: RoutingDecision;
  /** For review tasks: which task is reviewed. */
  reviewOf?: string;
  /** Escalation floor: minimum tier after failures. */
  minTier: number;
  excludedModels: string[];
  resultSummary?: string;
  artifactIds: string[];
  reviewIds: string[];
  verified: boolean;
  usage: Usage;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Revision feedback for the next attempt. */
  feedback?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  ok?: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface Agent {
  id: string;
  taskId: string;
  parentAgentId?: string;
  role: AgentRole;
  provider: ProviderId;
  model: string;
  modelId: string;
  effort?: string;
  depth: number;
  attempt: number;
  status: AgentStatus;
  statusReason?: string;
  sessionId?: string;
  pid?: number;
  usage: Usage;
  toolCalls: ToolCall[]; // most recent (bounded)
  toolCount: number;
  outputTail: string[]; // most recent lines (bounded)
  lastActivity: number;
  startedAt: number;
  endedAt?: number;
}

export interface Artifact {
  id: string;
  taskId: string;
  agentId?: string;
  kind: 'report' | 'file' | 'diff' | 'data' | 'plan' | 'verdict';
  title: string;
  path: string; // relative to the run's artifact dir or workspace
  bytes: number;
  summary?: string;
  createdAt: number;
}

export interface ReviewVerdict {
  id: string;
  reviewTaskId: string;
  targetTaskId: string;
  reviewerAgentId: string;
  verdict: 'pass' | 'revise' | 'fail';
  confidence: number;
  summary: string;
  issues: { severity: 'minor' | 'major' | 'critical'; description: string }[];
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  from: 'user' | 'orchestrator' | 'system' | 'agent';
  agentId?: string;
  text: string;
  /** Task ids referenced, for chat ↔ graph linking. */
  refs?: string[];
  ts: number;
}

export interface Approval {
  id: string;
  kind: 'permission' | 'budget' | 'git-commit' | 'git-push' | 'pull-request' | 'delegation' | 'other';
  description: string;
  taskId?: string;
  payload?: unknown;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  resolvedAt?: number;
}

export interface QuotaWindow {
  provider: ProviderId;
  window: string;
  utilization?: number; // 0..1
  resetsAt?: number;
  status?: string;
  observedAt: number;
}

export interface RunInfo {
  id: string;
  title: string;
  objective: string;
  workspace: string;
  config: RunConfig;
  status: RunStatus;
  statusReason?: string;
  createdAt: number;
  endedAt?: number;
  rootTaskId?: string;
  finalArtifactId?: string;
}

export interface Signal {
  /** Transient flow for animation: derived from a real event. */
  from: string; // agent or task id
  to: string;
  kind: 'handoff' | 'delegation' | 'review' | 'result' | 'message';
  seq: number;
}

export interface RunState {
  run: RunInfo;
  tasks: Record<string, Task>;
  agents: Record<string, Agent>;
  artifacts: Record<string, Artifact>;
  reviews: Record<string, ReviewVerdict>;
  messages: ChatMessage[];
  approvals: Record<string, Approval>;
  quotas: Record<string, QuotaWindow>;
  usageByProvider: Record<string, Usage>;
  totals: Usage & { retryTokens: number; reviewTokens: number; duplicateRejected: number };
  limitEvents: { limit: string; detail: string; ts: number }[];
  escalations: { taskId: string; from: string; to?: string; reason: string; ts: number }[];
  signals: Signal[]; // recent flows (bounded)
  lastSeq: number;
  lastTs: number;
}
