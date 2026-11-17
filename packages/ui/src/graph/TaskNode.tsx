import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Agent, Task } from '@synape/core';
import { KIND_LABEL, STATUS_LABEL, familyOfProvider, fmtTokens, isActive, tokensOf } from '../util';

export interface TaskNodeData extends Record<string, unknown> {
  task: Task;
  agent?: Agent;
  childCount: number;
  collapsed: boolean;
  activeTools: string | null;
  sig: string;
  dim: boolean;
  onToggle: (id: string) => void;
}
export type TaskFlowNode = Node<TaskNodeData, 'task'>;

const statusTone = (t: Task) =>
  t.status === 'failed' ? 'bad' : t.status === 'cancelled' ? 'idle' : t.status === 'blocked' ? 'warn' : t.status === 'completed' ? (t.verified || t.verification === 'none' || t.kind !== 'work' ? 'ok' : 'warn') : t.status === 'running' || t.status === 'delegated' || t.status === 'awaiting_review' ? 'live' : 'idle';

/** The "soma": a neuron body whose membrane ring shows context utilization. */
function Soma({ agent, task, size }: { agent?: Agent; task: Task; size: number }) {
  const fam = agent ? familyOfProvider(agent.provider) : 'other';
  const color = task.kind === 'plan' || task.kind === 'orchestrate' ? 'var(--nucleus)' : fam === 'anthropic' ? 'var(--ember)' : fam === 'openai' ? 'var(--ion)' : 'var(--idle)';
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const u = agent?.usage;
  const ctxFrac = u?.peakContextTokens && u.contextWindow ? Math.min(1, u.peakContextTokens / u.contextWindow) : undefined;
  const live = isActive(agent);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`soma ${live ? 'live' : ''}`} aria-hidden>
      <defs>
        <radialGradient id={`g-${task.id}`} cx="50%" cy="45%" r="55%">
          <stop offset="0" stopColor="#fff" stopOpacity={agent ? 0.95 : 0.4} />
          <stop offset="0.35" stopColor={color} stopOpacity={agent ? 0.9 : 0.35} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </radialGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(140,160,220,0.16)" strokeWidth={2.5} />
      {ctxFrac !== undefined && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray={`${c * ctxFrac} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} opacity={0.9}>
          <title>{`peak context ${fmtTokens(u!.peakContextTokens)} / ${fmtTokens(u!.contextWindow)}`}</title>
        </circle>
      )}
      {live && <circle className="soma-orbit" cx={size / 2} cy={size / 2} r={r + 0.5} fill="none" stroke={color} strokeWidth={1.2} strokeDasharray="3 7" />}
      <circle cx={size / 2} cy={size / 2} r={r * 0.62} fill={`url(#g-${task.id})`} />
      {task.verified && <path d={`M${size * 0.36} ${size * 0.52} l${size * 0.1} ${size * 0.1} l${size * 0.18} -${size * 0.22}`} stroke="#04140c" strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function TaskNodeView({ data, selected }: NodeProps<TaskFlowNode>) {
  const { task: t, agent: a } = data;
  const tone = statusTone(t);
  const fam = a ? familyOfProvider(a.provider) : undefined;
  const hub = t.kind === 'plan' || t.kind === 'orchestrate';
  if (t.kind === 'review') {
    const v = t.resultSummary?.split(' ')[0];
    return (
      <div className={`tnode review tone-${tone} ${selected ? 'sel' : ''} ${data.dim ? 'dim' : ''}`} data-verdict={v}>
        <Handle type="target" position={Position.Left} className="h" />
        <Soma agent={a} task={t} size={26} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="eyebrow" style={{ fontSize: 8.5 }}>{t.title.startsWith('Cross') ? 'CROSS-CHECK' : 'REVIEW'}</div>
          <div className="tn-meta ellipsis">{t.status === 'completed' ? v : a ? (a.modelId.split(':')[1] ?? a.modelId) : STATUS_LABEL[t.status]}</div>
        </div>
        <Handle type="source" position={Position.Right} className="h" />
      </div>
    );
  }
  return (
    <div className={`tnode ${hub ? 'hub' : 'work'} tone-${tone} fam-${fam ?? 'none'} ${selected ? 'sel' : ''} ${data.dim ? 'dim' : ''}`}>
      <Handle type="target" position={Position.Left} className="h" />
      <Soma agent={a} task={t} size={hub ? 40 : 32} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="eyebrow" style={{ color: hub ? 'var(--nucleus)' : undefined }}>
            {KIND_LABEL[t.kind]}
            {t.depth > 0 && hub ? ` · L${t.depth}` : ''}
          </span>
          <span className="grow" />
          <span className={`tn-status s-${tone}`}>{STATUS_LABEL[t.status]}</span>
        </div>
        <div className="tn-title ellipsis" title={t.title}>
          {t.title}
        </div>
        <div className="tn-meta row" style={{ gap: 6 }}>
          {a ? <span className={`ellipsis fam-text-${fam}`}>{a.modelId.replace('claude-code:', 'claude ').replace('codex:', '')}</span> : <span className="faint">c{t.complexity} · {t.category}</span>}
          <span className="grow" />
          {tokensOf(t.usage) > 0 && <span className="faint">{fmtTokens(tokensOf(t.usage))}</span>}
          {t.attempts > 1 && <span className="tn-badge">×{t.attempts}</span>}
        </div>
        {data.activeTools && <div className="tn-tool ellipsis">⟡ {data.activeTools}</div>}
      </div>
      {hub && data.childCount > 0 && (
        <button
          className="tn-collapse"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(t.id);
          }}
          aria-label={data.collapsed ? 'Expand cluster' : 'Collapse cluster'}
          title={data.collapsed ? `Expand ${data.childCount} tasks` : 'Collapse cluster'}
        >
          {data.collapsed ? `+${data.childCount}` : '–'}
        </button>
      )}
      <Handle type="source" position={Position.Right} className="h" />
    </div>
  );
}

export const TaskNode = memo(TaskNodeView, (a, b) => a.data.sig === b.data.sig && a.selected === b.selected);
