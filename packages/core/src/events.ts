import type {
  AgentRole,
  AgentStatus,
  Approval,
  Artifact,
  ProviderId,
  ReviewVerdict,
  RoutingDecision,
  RunConfig,
  RunStatus,
  TaskSpec,
  TaskStatus,
  Usage,
} from './types.ts';

/**
 * Event payloads. Every state change in the system is one of these, persisted
 * in order. The reducer in `reducer.ts` is the only code that turns events
 * into state; scheduler, UI, dashboard and replay all read that state.
 */
export type EventBody =
  | { type: 'run.created'; runId: string; title: string; objective: string; workspace: string; config: RunConfig }
  | { type: 'run.status'; status: RunStatus; reason?: string }
  | { type: 'run.config'; config: RunConfig }
  | { type: 'chat.message'; messageId: string; from: 'user' | 'orchestrator' | 'system' | 'agent'; agentId?: string; text: string; refs?: string[] }
  | ({ type: 'task.created'; taskId: string; parentTaskId?: string; createdBy?: string; depth: number; deps: string[]; reviewOf?: string } & TaskSpec)
  | { type: 'task.deps'; taskId: string; deps: string[] }
  | { type: 'task.status'; taskId: string; status: TaskStatus; reason?: string }
  | { type: 'task.routed'; taskId: string; decision: RoutingDecision }
  | { type: 'task.result'; taskId: string; summary: string; verified?: boolean }
  | { type: 'task.feedback'; taskId: string; feedback: string }
  | { type: 'task.escalated'; taskId: string; fromModel: string; minTier: number; excludeModel?: string; reason: string }
  | { type: 'agent.spawned'; agentId: string; taskId: string; parentAgentId?: string; role: AgentRole; provider: ProviderId; model: string; modelId: string; effort?: string; depth: number; attempt: number }
  | { type: 'agent.status'; agentId: string; status: AgentStatus; reason?: string; pid?: number }
  | { type: 'agent.role'; agentId: string; role: AgentRole; reason: string }
  | { type: 'agent.session'; agentId: string; sessionId: string }
  | { type: 'agent.output'; agentId: string; stream: 'text' | 'thinking' | 'stderr' | 'system'; text: string }
  | { type: 'tool.started'; agentId: string; toolId: string; name: string; input: string }
  | { type: 'tool.finished'; agentId: string; toolId: string; ok: boolean; output: string }
  | { type: 'usage'; agentId: string; taskId: string; provider: ProviderId; model: string; usage: Usage; final: boolean }
  | { type: 'quota'; provider: ProviderId; window: string; utilization?: number; resetsAt?: number; status?: string }
  | ({ type: 'artifact.created' } & Omit<Artifact, 'createdAt'>)
  | ({ type: 'review.verdict' } & Omit<ReviewVerdict, 'createdAt'>)
  | { type: 'delegation.requested'; agentId: string; taskId: string; reason: string; subtasks: number }
  | { type: 'delegation.decided'; agentId: string; taskId: string; approved: boolean; reason: string }
  | ({ type: 'approval.requested' } & Omit<Approval, 'status' | 'createdAt' | 'resolvedAt'>)
  | { type: 'approval.resolved'; approvalId: string; approved: boolean; note?: string }
  | { type: 'limit.hit'; limit: string; detail: string; taskId?: string }
  | { type: 'duplicate.rejected'; title: string; existingTaskId: string }
  | { type: 'error'; message: string; agentId?: string; taskId?: string; recoverable: boolean }
  | { type: 'recovery'; detail: string; taskIds: string[] };

export type EventType = EventBody['type'];

export interface EventEnvelope<B extends EventBody = EventBody> {
  /** Monotonic per-run sequence number assigned by the store. */
  seq: number;
  id: string;
  runId: string;
  ts: number;
  /** Groups events belonging to one logical operation (e.g. one agent run). */
  correlationId?: string;
  /** The event that caused this one. */
  causationId?: string;
  body: B;
}

export type SynapeEvent = EventEnvelope;
