import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Agent, ComputeStat, Task } from '@synape/core';
import { KIND_LABEL, STATUS_LABEL, familyOfProvider, fmtTokens, isActive, programHue, tokensOf } from '../util';
import { orbSize } from './layout';

export interface TaskNodeData extends Record<string, unknown> {
  task: Task;
  agent?: Agent;
  childCount: number;
  collapsed: boolean;
  activeTools: string | null;
  sig: string;
  dim: boolean;
  animate: boolean;
  onToggle: (id: string) => void;
}
export type TaskFlowNode = Node<TaskNodeData, 'task'>;

export interface ComputeNodeData extends Record<string, unknown> {
  taskId: string;
  stat: ComputeStat;
  sig: string;
  dim: boolean;
  animate: boolean;
}
export type ComputeFlowNode = Node<ComputeNodeData, 'compute'>;

const statusTone = (t: Task) =>
  t.status === 'failed' ? 'bad' : t.status === 'cancelled' ? 'idle' : t.status === 'blocked' ? 'warn' : t.status === 'completed' ? (t.verified || t.verification === 'none' || t.kind !== 'work' ? 'ok' : 'warn') : t.status === 'running' || t.status === 'delegated' || t.status === 'awaiting_review' ? 'live' : 'idle';

// Literal colors: SVG gradient stops don't reliably resolve CSS variables.
const C = { ember: '#ff9f6e', ion: '#5ee7ff', nucleus: '#b8a6ff', ok: '#6dffb3', warn: '#ffd36b', bad: '#ff5c7a', idle: '#56628a', text: '#e6ebff' };
const TONE_COLOR: Record<string, string> = { ok: C.ok, warn: C.warn, bad: C.bad, live: C.text, idle: C.idle };

/** Cheap deterministic PRNG so particle clouds stay put across renders. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const ellipse = (cx: number, cy: number, rx: number, ry: number) => `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${2 * rx} 0 a ${rx} ${ry} 0 1 0 ${-2 * rx} 0`;

/**
 * A WIMP-like orb: glowing core, glass shell, context-usage arc and, for
 * orchestrators, electron orbits. Motion only while the agent is live.
 */
function Orb({ id, d, color, live, hub, animate, ctxFrac, tone, verified, faint, electrons }: { id: string; d: number; color: string; live: boolean; hub: boolean; animate: boolean; ctxFrac?: number; tone: string; verified: boolean; faint: boolean; electrons: number }) {
  const c = d / 2;
  const shell = c - 1.5;
  const core = d * (hub ? 0.26 : 0.3);
  const rand = rng(id);
  const motion = live && animate;
  const particles = Array.from({ length: hub ? 14 : 8 }, () => ({ a: rand() * Math.PI * 2, r: core * 1.15 + rand() * (shell - core * 1.2), s: 0.6 + rand() * 1.1, dur: 1.4 + rand() * 2.4 }));
  const orbits = Array.from({ length: electrons }, (_, i) => ({ tilt: (180 / electrons) * i + 20, rx: c * (hub ? 1.32 : 1.18), ry: c * (hub ? 0.42 : 0.36), dur: 3.2 + i * 1.3 }));
  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="orb-svg" aria-hidden>
      <defs>
        <radialGradient id={`core-${id}`} cx="38%" cy="34%" r="70%">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.28" stopColor={color} stopOpacity={0.98} />
          <stop offset="0.75" stopColor={color} stopOpacity={0.55} />
          <stop offset="1" stopColor="#05060f" stopOpacity={0.9} />
        </radialGradient>
        <radialGradient id={`glass-${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0.55" stopColor={color} stopOpacity={0} />
          <stop offset="0.92" stopColor={color} stopOpacity={0.16} />
          <stop offset="1" stopColor={color} stopOpacity={0.4} />
        </radialGradient>
      </defs>
      {/* glass shell */}
      <circle cx={c} cy={c} r={shell} fill={`url(#glass-${id})`} stroke={color} strokeOpacity={faint ? 0.18 : 0.38} strokeWidth={1} />
      {/* status ring */}
      {tone !== 'live' && tone !== 'idle' && <circle cx={c} cy={c} r={shell + 3.5} fill="none" stroke={TONE_COLOR[tone]} strokeOpacity={0.75} strokeWidth={1.4} strokeDasharray={tone === 'warn' ? '3 3' : undefined} />}
      {/* context utilization arc */}
      {ctxFrac !== undefined && (
        <circle cx={c} cy={c} r={shell} fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeDasharray={`${2 * Math.PI * shell * ctxFrac} ${2 * Math.PI * shell}`} transform={`rotate(-90 ${c} ${c})`} className="orb-ctx" />
      )}
      {/* spinning dashed shell while live */}
      {live && <circle cx={c} cy={c} r={shell - 4} fill="none" stroke={color} strokeOpacity={0.7} strokeWidth={1.1} strokeDasharray="2 6" className={motion ? 'orb-spin' : ''} />}
      {/* electron orbits */}
      {orbits.map((o, i) => (
        <g key={i} transform={`rotate(${o.tilt} ${c} ${c})`} opacity={faint ? 0.25 : 0.85}>
          <path d={ellipse(c, c, o.rx, o.ry)} fill="none" stroke={color} strokeOpacity={0.32} strokeWidth={0.9} />
          {motion ? (
            <circle r={hub ? 2.6 : 2} fill="#fff" className="orb-electron" style={{ color }}>
              <animateMotion dur={`${o.dur}s`} repeatCount="indefinite" path={ellipse(c, c, o.rx, o.ry)} />
            </circle>
          ) : (
            <circle cx={c + o.rx} cy={c} r={hub ? 2.6 : 2} fill="#fff" className="orb-electron" style={{ color }} />
          )}
        </g>
      ))}
      {/* particle cloud */}
      {!faint &&
        particles.map((p, i) => (
          <circle key={i} cx={c + Math.cos(p.a) * p.r} cy={c + Math.sin(p.a) * p.r} r={p.s} fill={color} opacity={live ? 0.9 : 0.35} className={motion ? 'orb-twinkle' : ''} style={motion ? { animationDuration: `${p.dur}s`, animationDelay: `${-p.dur * (i / particles.length)}s` } : undefined} />
        ))}
      {/* core */}
      <circle cx={c} cy={c} r={core} fill={`url(#core-${id})`} opacity={faint ? 0.45 : 1} className={motion ? 'orb-core live' : 'orb-core'} />
      <ellipse cx={c - core * 0.32} cy={c - core * 0.4} rx={core * 0.32} ry={core * 0.18} fill="#fff" opacity={0.55} transform={`rotate(-30 ${c - core * 0.32} ${c - core * 0.4})`} />
      {verified && <path d={`M${c - core * 0.45} ${c + core * 0.02} l${core * 0.32} ${core * 0.32} l${core * 0.6} -${core * 0.64}`} stroke="#04140c" strokeWidth={Math.max(2, core * 0.18)} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function TaskNodeView({ data, selected }: NodeProps<TaskFlowNode>) {
  const { task: t, agent: a } = data;
  const tone = statusTone(t);
  const fam = a ? familyOfProvider(a.provider) : undefined;
  const hub = t.kind === 'plan' || t.kind === 'orchestrate';
  const review = t.kind === 'review';
  const d = orbSize(t);
  const verdict = review ? t.resultSummary?.split(' ')[0] : undefined;
  const color = review && verdict ? (verdict === 'pass' ? C.ok : verdict === 'fail' ? C.bad : C.warn) : t.status === 'failed' ? C.bad : hub ? C.nucleus : fam === 'anthropic' ? C.ember : fam === 'openai' ? C.ion : C.idle;
  const live = isActive(a) || (hub && t.status === 'delegated');
  const u = a?.usage;
  const ctxFrac = u?.peakContextTokens && u.contextWindow ? Math.min(1, u.peakContextTokens / u.contextWindow) : undefined;
  const faint = !a && !hub;
  return (
    <div className={`orb-node k-${t.kind} tone-${tone} fam-${fam ?? 'none'} ${live ? 'live' : ''} ${selected ? 'sel' : ''} ${data.dim ? 'dim' : ''} ${faint ? 'faint' : ''}`} style={{ width: d, height: d, ['--c' as string]: color }}>
      <Handle type="target" position={Position.Left} className="h" />
      <div className="orb-halo" />
      <Orb id={t.id} d={d} color={color} live={live} hub={hub} animate={data.animate} ctxFrac={ctxFrac} tone={tone} verified={t.verified} faint={faint} electrons={t.kind === 'plan' ? 3 : t.kind === 'orchestrate' ? 2 : t.kind === 'synthesize' ? 1 : 0} />
      <div className={`orb-label ${review ? 'small' : ''}`} style={{ top: d + (review ? 4 : 8) }}>
        {review ? (
          <div className="orb-eyebrow">
            {t.title.startsWith('Cross') ? 'CROSS-CHECK' : 'REVIEW'} · <span className={`s-${tone}`}>{t.status === 'completed' ? verdict : a ? (a.modelId.split(':')[1] ?? a.modelId) : STATUS_LABEL[t.status]}</span>
          </div>
        ) : (
          <>
            <div className="orb-eyebrow">
              <span style={{ color: hub ? 'var(--nucleus)' : undefined }}>
                {KIND_LABEL[t.kind]}
                {t.depth > 0 && hub ? ` · L${t.depth}` : ''}
              </span>
              {' · '}
              <span className={`s-${tone}`}>{STATUS_LABEL[t.status]}</span>
            </div>
            <div className={`orb-title ${hub ? 'hub' : ''}`} title={t.title}>
              {t.title}
            </div>
            <div className="orb-meta">
              {a ? <span className={`fam-text-${fam}`}>{a.modelId.replace('claude-code:', 'claude ').replace('codex:', '')}</span> : <span className="faint">c{t.complexity} · {t.category}</span>}
              {tokensOf(t.usage) > 0 && <span className="faint"> · {fmtTokens(tokensOf(t.usage))}</span>}
              {t.attempts > 1 && <span className="tn-badge">×{t.attempts}</span>}
            </div>
            {data.activeTools && <div className="orb-tool">⟡ {data.activeTools}</div>}
          </>
        )}
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

export const TaskNode = memo(TaskNodeView, (a, b) => a.data.sig === b.data.sig && a.selected === b.selected && a.data.animate === b.data.animate);

export const COMPUTE_SIZE = 22;

/** A computation (Python, Wolfram, MadGraph…): a small satellite whose color is derived from the program name. */
function ComputeNodeView({ data }: NodeProps<ComputeFlowNode>) {
  const { stat } = data;
  const hue = programHue(stat.program);
  const color = `hsl(${hue} 92% 64%)`;
  const running = stat.running > 0;
  const d = COMPUTE_SIZE;
  const c = d / 2;
  const tip = `${stat.program}: ${stat.runs} run${stat.runs === 1 ? '' : 's'}${running ? `, ${stat.running} running` : ''} (${stat.ok} ok${stat.failed ? `, ${stat.failed} failed` : ''})\nlast: ${stat.lastInput}`;
  return (
    <div className={`orb-node compute ${running ? 'live' : ''} ${data.dim ? 'dim' : ''}`} style={{ width: d, height: d, ['--c' as string]: color }} title={tip}>
      <Handle type="target" position={Position.Left} className="h" />
      <div className="orb-halo" />
      {running && data.animate && <div className="orb-ripple" />}
      <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="orb-svg" aria-hidden>
        <defs>
          <radialGradient id={`cmp-${data.taskId}-${hue}`} cx="38%" cy="34%" r="70%">
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.35" stopColor={color} />
            <stop offset="1" stopColor={color} stopOpacity={0.35} />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c} r={c - 1} fill="none" stroke={color} strokeOpacity={0.5} strokeWidth={1} strokeDasharray={running ? '2 3' : undefined} className={running && data.animate ? 'orb-spin fast' : ''} />
        <circle cx={c} cy={c} r={c * 0.55} fill={`url(#cmp-${data.taskId}-${hue})`} />
        {stat.failed > 0 && <circle cx={d - 3} cy={3} r={2.6} fill="var(--bad)" />}
      </svg>
      <div className="orb-label compute" style={{ top: d + 3 }}>
        <span style={{ color }}>{stat.program}</span>
        {stat.runs > 1 && <span className="faint"> ×{stat.runs}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="h" />
    </div>
  );
}

export const ComputeNode = memo(ComputeNodeView, (a, b) => a.data.sig === b.data.sig && a.data.animate === b.data.animate);
