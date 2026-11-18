import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Agent, ComputeStat, Task } from '@synape/core';
import { classifyCompute } from '@synape/core';
import { KIND_LABEL, STATUS_LABEL, familyOfProvider, fmtTokens, isActive, programHue, tokensOf } from '../util';
import { orbSize } from './layout';

/** A child of an orchestrator, as drawn on its progress dial. */
export interface KidMark {
  id: string;
  status: Task['status'];
  verified: boolean;
  color: string;
  tokens: number;
  live: boolean;
}

export interface TaskNodeData extends Record<string, unknown> {
  task: Task;
  agent?: Agent;
  kids: KidMark[];
  childCount: number;
  collapsed: boolean;
  activeTools: string | null;
  figures: number;
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

// Literal colors: SVG paint servers don't reliably resolve CSS variables.
export const C = { ember: '#ff9f6e', ion: '#5ee7ff', leaf: '#b6f35c', nucleus: '#b8a6ff', ok: '#6dffb3', warn: '#ffd36b', bad: '#ff5c7a', idle: '#56628a', text: '#e6ebff' };
const TONE_COLOR: Record<string, string> = { ok: C.ok, warn: C.warn, bad: C.bad, live: C.text, idle: C.idle };

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};
const polar = (c: number, r: number, a: number) => [c + Math.cos(a) * r, c + Math.sin(a) * r] as const;
const arc = (c: number, r: number, a0: number, a1: number) => {
  const [x0, y0] = polar(c, r, a0);
  const [x1, y1] = polar(c, r, a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
};
/** A charged-particle track: a curved arc from the vertex out to (r, a). */
const track = (c: number, r: number, a: number, bend: number) => {
  const [x, y] = polar(c, r, a);
  const [mx, my] = polar(c, r / 2, a);
  const nx = -Math.sin(a) * bend * r;
  const ny = Math.cos(a) * bend * r;
  return `M ${c} ${c} Q ${mx + nx} ${my + ny} ${x} ${y}`;
};
const START = -Math.PI / 2;

interface ToolMark {
  id: string;
  bin: number;
  color: string;
  running: boolean;
}

/**
 * Worker as an event display: tool activity over the agent's lifetime fills
 * calorimeter towers (angle = time, height = activity, tint = program), recent
 * tool calls are tracks pointing at their tower, the inner gauge is context use.
 */
function WorkerDetector({ id, d, color, tone, live, motion, agent, faint, verified }: { id: string; d: number; color: string; tone: string; live: boolean; motion: boolean; agent?: Agent; faint: boolean; verified: boolean }) {
  const c = d / 2;
  const R = c - 1;
  const N = 40;
  const calls = agent?.toolCalls ?? [];
  const t0 = agent?.startedAt ?? 0;
  const t1 = Math.max(t0 + 1, agent?.endedAt ?? Math.max(t0 + 1, ...calls.map((x) => x.endedAt ?? x.startedAt)));
  const bins = Array.from({ length: N }, () => ({ n: 0, color }));
  const marks: ToolMark[] = calls.map((x) => {
    const bin = Math.min(N - 1, Math.floor(((x.startedAt - t0) / (t1 - t0)) * N));
    const prog = classifyCompute(x.name, x.input);
    const col = prog ? `hsl(${programHue(prog)} 92% 64%)` : /write|edit|patch/i.test(x.name) ? '#f4f0ff' : color;
    bins[bin].n++;
    if (prog) bins[bin].color = col;
    return { id: x.id, bin, color: col, running: !x.endedAt && live };
  });
  const max = Math.max(1, ...bins.map((b) => b.n));
  const r0 = R * 0.66;
  const ctx = agent?.usage.peakContextTokens && agent.usage.contextWindow ? Math.min(1, agent.usage.peakContextTokens / agent.usage.contextWindow) : undefined;
  const angleOf = (i: number) => START + ((i + 0.5) / N) * Math.PI * 2;
  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="orb-svg" aria-hidden>
      <defs>
        <radialGradient id={`bg-${id}`}>
          <stop offset="0" stopColor={color} stopOpacity={faint ? 0.04 : 0.16} />
          <stop offset="0.7" stopColor="#060914" stopOpacity={0.92} />
          <stop offset="1" stopColor="#060914" stopOpacity={0.98} />
        </radialGradient>
        <linearGradient id={`sw-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={color} stopOpacity={0} />
          <stop offset="1" stopColor={color} stopOpacity={0.45} />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={R} fill={`url(#bg-${id})`} />
      {/* radar sweep while live */}
      {motion && (
        <g className="det-sweep">
          <path d={`M ${c} ${c} L ${c + r0} ${c} A ${r0} ${r0} 0 0 0 ${polar(c, r0, -0.9)[0]} ${polar(c, r0, -0.9)[1]} Z`} fill={`url(#sw-${id})`} />
        </g>
      )}
      {/* tracker layers */}
      {[0.24, 0.4].map((k) => (
        <circle key={k} cx={c} cy={c} r={R * k} fill="none" stroke={color} strokeOpacity={faint ? 0.08 : 0.16} strokeWidth={0.6} strokeDasharray={k > 0.3 ? '1 2' : undefined} />
      ))}
      {/* context gauge */}
      <circle cx={c} cy={c} r={R * 0.53} fill="none" stroke="#fff" strokeOpacity={0.07} strokeWidth={2} />
      {ctx !== undefined && <path d={arc(c, R * 0.53, START, START + Math.max(0.05, ctx * Math.PI * 2 - 0.001))} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" className="det-glow" />}
      {/* calorimeter towers */}
      {bins.map((b, i) => {
        const v = b.n / max;
        const len = b.n ? R * (0.1 + 0.36 * v) : R * 0.05;
        const a = angleOf(i);
        const [x0, y0] = polar(c, r0, a);
        const [x1, y1] = polar(c, r0 + len, a);
        return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={b.color} strokeOpacity={b.n ? 0.45 + 0.55 * v : faint ? 0.12 : 0.22} strokeWidth={b.n ? 2.4 : 1} strokeLinecap="round" />;
      })}
      {/* tracks for the most recent tool calls */}
      {marks.slice(-14).map((m) => (
        <path key={m.id} d={track(c, r0 - 1, angleOf(m.bin), (hash(m.id) - 0.5) * 0.9)} fill="none" stroke={m.color} strokeWidth={m.running ? 1.5 : 0.8} strokeOpacity={m.running ? 1 : 0.55} className={m.running && motion ? 'det-track live' : 'det-track'} />
      ))}
      {/* outer boundary = status */}
      <circle cx={c} cy={c} r={R} fill="none" stroke={tone === 'live' || tone === 'idle' ? color : TONE_COLOR[tone]} strokeOpacity={tone === 'idle' ? 0.3 : 0.85} strokeWidth={tone === 'ok' || tone === 'bad' ? 1.6 : 1} strokeDasharray={tone === 'warn' || !agent ? '3 3' : undefined} />
      {/* primary vertex */}
      <circle cx={c} cy={c} r={live ? 2.8 : 2.2} fill="#fff" className={motion ? 'det-vertex live det-glow' : 'det-vertex det-glow'} style={{ color }} />
      {verified && <path d={`M${c - 6} ${c + 0.5} l4 4 l8 -9`} transform={`translate(0 ${R * 0.24})`} stroke={C.ok} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/**
 * Orchestrator as a progress dial: one outer segment per subtask (colored by
 * its state, flowing while it runs), decay tracks to each, energy deposited
 * proportional to each subtask's token use.
 */
function HubDetector({ id, d, color, tone, live, motion, kids, root, faint }: { id: string; d: number; color: string; tone: string; live: boolean; motion: boolean; kids: KidMark[]; root: boolean; faint: boolean }) {
  const c = d / 2;
  const R = c - 1;
  const k = Math.max(1, kids.length);
  const gap = kids.length > 1 ? Math.min(0.12, (Math.PI * 2) / k / 5) : 0;
  const maxTok = Math.max(1, ...kids.map((x) => x.tokens));
  const segColor = (x: KidMark) => (x.status === 'failed' ? C.bad : x.status === 'cancelled' ? C.idle : x.status === 'completed' ? (x.verified ? C.ok : x.color) : x.live || x.status === 'running' || x.status === 'delegated' ? x.color : C.idle);
  const done = kids.filter((x) => x.status === 'completed').length;
  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="orb-svg" aria-hidden>
      <defs>
        <radialGradient id={`bg-${id}`}>
          <stop offset="0" stopColor={color} stopOpacity={0.22} />
          <stop offset="0.55" stopColor="#070a18" stopOpacity={0.94} />
          <stop offset="1" stopColor="#070a18" stopOpacity={0.98} />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={R} fill={`url(#bg-${id})`} />
      {/* dial ticks (root only) */}
      {root && (
        <g className={motion ? 'det-spin slow' : ''} opacity={0.5}>
          {Array.from({ length: 72 }, (_, i) => {
            const a = (i / 72) * Math.PI * 2;
            const [x0, y0] = polar(c, R * 1.1, a);
            const [x1, y1] = polar(c, R * (i % 6 ? 1.13 : 1.17), a);
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={color} strokeWidth={i % 6 ? 0.6 : 1.1} />;
          })}
        </g>
      )}
      {/* concentric detector layers */}
      {[0.2, 0.32, 0.46, 0.6].map((q, i) => (
        <circle key={q} cx={c} cy={c} r={R * q} fill="none" stroke={color} strokeOpacity={0.1 + i * 0.03} strokeWidth={0.7} strokeDasharray={i % 2 ? '2 3' : undefined} />
      ))}
      {/* per-subtask energy deposits and decay tracks */}
      {kids.map((x, i) => {
        const a0 = START + (i / k) * Math.PI * 2 + gap / 2;
        const a1 = START + ((i + 1) / k) * Math.PI * 2 - gap / 2;
        const mid = (a0 + a1) / 2;
        const e = x.tokens ? 0.25 + 0.75 * (Math.log1p(x.tokens) / Math.log1p(maxTok)) : 0;
        const col = segColor(x);
        const bars = Math.max(2, Math.min(7, Math.round(((a1 - a0) * R) / 7)));
        return (
          <g key={x.id}>
            <path d={track(c, R * 0.68, mid, (hash(x.id) - 0.5) * 0.7)} fill="none" stroke={col} strokeWidth={x.live ? 1.4 : 0.8} strokeOpacity={x.status === 'pending' || x.status === 'ready' ? 0.25 : 0.7} className={x.live && motion ? 'det-track live' : 'det-track'} />
            {Array.from({ length: bars }, (_, j) => {
              const a = a0 + ((j + 0.5) / bars) * (a1 - a0);
              const h = e * (0.55 + 0.45 * hash(x.id + j)) * R * 0.17;
              const [x0, y0] = polar(c, R * 0.72, a);
              const [x1, y1] = polar(c, R * 0.72 + Math.max(1.2, h), a);
              return <line key={j} x1={x0} y1={y0} x2={x1} y2={y1} stroke={col} strokeOpacity={e ? 0.85 : 0.2} strokeWidth={1.6} strokeLinecap="round" />;
            })}
            {/* outer progress segment */}
            <path d={arc(c, R - 1.5, a0, a1)} fill="none" stroke={col} strokeWidth={3.2} strokeOpacity={x.status === 'pending' || x.status === 'ready' ? 0.3 : 0.95} strokeLinecap="butt" strokeDasharray={x.live ? '4 3' : undefined} className={x.live && motion ? 'det-flow' : ''} />
          </g>
        );
      })}
      {!kids.length && <circle cx={c} cy={c} r={R - 1.5} fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5} strokeDasharray="3 4" className={motion ? 'det-spin' : ''} />}
      {/* status halo ring */}
      {(tone === 'ok' || tone === 'bad' || tone === 'warn') && <circle cx={c} cy={c} r={R + 3.5} fill="none" stroke={TONE_COLOR[tone]} strokeOpacity={0.7} strokeWidth={1} />}
      {/* primary vertex: hexagon */}
      <polygon points={Array.from({ length: 6 }, (_, i) => polar(c, R * 0.11, (i / 6) * Math.PI * 2 + Math.PI / 6).join(',')).join(' ')} fill="none" stroke={color} strokeWidth={1.2} className={motion ? 'det-spin' : ''} opacity={faint ? 0.4 : 1} />
      <circle cx={c} cy={c} r={live ? 3.4 : 2.8} fill="#fff" className={motion ? 'det-vertex live det-glow' : 'det-vertex det-glow'} style={{ color }} />
      {kids.length > 0 && (
        <text x={c} y={c + R * 0.3} textAnchor="middle" className="det-count" fill={color}>
          {done}/{kids.length}
        </text>
      )}
    </svg>
  );
}

/** Reviewer: an inspection reticle with the verdict at its centre. */
function ReviewReticle({ d, color, live, motion, verdict }: { d: number; color: string; live: boolean; motion: boolean; verdict?: string }) {
  const c = d / 2;
  const R = c - 1;
  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="orb-svg" aria-hidden>
      <circle cx={c} cy={c} r={R} fill="#060914" fillOpacity={0.9} stroke={color} strokeOpacity={0.8} strokeWidth={1} strokeDasharray={verdict ? undefined : '2 2'} />
      <g className={live && motion ? 'det-spin' : ''}>
        {[0, 1, 2, 3].map((i) => {
          const a = (i * Math.PI) / 2;
          const [x0, y0] = polar(c, R * 0.62, a);
          const [x1, y1] = polar(c, R * 1.18, a);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={color} strokeWidth={1} />;
        })}
      </g>
      <circle cx={c} cy={c} r={R * 0.42} fill="none" stroke={color} strokeOpacity={0.5} strokeWidth={0.8} />
      {verdict === 'pass' && <path d={`M${c - 4.5} ${c} l3 3 l6 -6.5`} stroke={color} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      {verdict === 'fail' && <path d={`M${c - 3.5} ${c - 3.5} l7 7 M${c + 3.5} ${c - 3.5} l-7 7`} stroke={color} strokeWidth={1.6} strokeLinecap="round" />}
      {verdict && verdict !== 'pass' && verdict !== 'fail' && <path d={arc(c, 4, -2.6, 1.6)} stroke={color} strokeWidth={1.5} fill="none" strokeLinecap="round" />}
      {!verdict && <circle cx={c} cy={c} r={1.6} fill={color} />}
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
  const color = review && verdict ? (verdict === 'pass' ? C.ok : verdict === 'fail' ? C.bad : C.warn) : t.status === 'failed' ? C.bad : hub ? C.nucleus : fam === 'anthropic' ? C.ember : fam === 'openai' ? C.ion : fam === 'local' ? C.leaf : C.idle;
  const live = isActive(a) || (hub && t.status === 'delegated' && data.kids.some((k) => k.live));
  const motion = live && data.animate;
  const faint = !a && !hub;
  return (
    <div className={`orb-node k-${t.kind} tone-${tone} fam-${fam ?? 'none'} ${live ? 'live' : ''} ${selected ? 'sel' : ''} ${data.dim ? 'dim' : ''} ${faint ? 'faint' : ''}`} style={{ width: d, height: d, ['--c' as string]: color }}>
      <Handle type="target" position={Position.Left} className="h" />
      <div className="orb-halo" />
      {review ? (
        <ReviewReticle d={d} color={color} live={live} motion={motion} verdict={verdict} />
      ) : hub ? (
        <HubDetector id={t.id} d={d} color={color} tone={tone} live={live} motion={motion} kids={data.kids} root={t.kind === 'plan' && t.depth === 0} faint={faint} />
      ) : (
        <WorkerDetector id={t.id} d={d} color={color} tone={tone} live={live} motion={motion} agent={a} faint={faint} verified={t.verified} />
      )}
      <div className={`orb-label ${review ? 'small' : ''}`} style={{ top: d + (review ? 4 : hub && t.depth === 0 ? 16 : 8) }}>
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
              {data.figures > 0 && <span className="tn-fig" title={`${data.figures} figure(s) produced`}>◫ {data.figures}</span>}
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

const hexPoints = (c: number, r: number) => Array.from({ length: 6 }, (_, i) => polar(c, r, (i / 6) * Math.PI * 2 + Math.PI / 6).join(',')).join(' ');

/** A computation (Python, Wolfram, MadGraph…): a hexagonal calorimeter crystal, color derived from the program name. */
function ComputeNodeView({ data }: NodeProps<ComputeFlowNode>) {
  const { stat } = data;
  const hue = programHue(stat.program);
  const color = `hsl(${hue} 92% 64%)`;
  const running = stat.running > 0;
  const d = COMPUTE_SIZE;
  const c = d / 2;
  const fill = Math.min(1, 0.35 + Math.log2(1 + stat.runs) / 6);
  const tip = `${stat.program}: ${stat.runs} run${stat.runs === 1 ? '' : 's'}${running ? `, ${stat.running} running` : ''} (${stat.ok} ok${stat.failed ? `, ${stat.failed} failed` : ''})\nlast: ${stat.lastInput}`;
  return (
    <div className={`orb-node compute ${running ? 'live' : ''} ${data.dim ? 'dim' : ''}`} style={{ width: d, height: d, ['--c' as string]: color }} title={tip}>
      <Handle type="target" position={Position.Left} className="h" />
      <div className="orb-halo" />
      {running && data.animate && <div className="orb-ripple" />}
      <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`} className="orb-svg" aria-hidden>
        <polygon points={hexPoints(c, c - 0.5)} fill="#070a16" stroke={color} strokeWidth={1.1} strokeOpacity={0.9} />
        <polygon points={hexPoints(c, (c - 3) * fill)} fill={color} fillOpacity={0.85} className="det-glow" style={{ color }} />
        {stat.failed > 0 && <circle cx={d - 2} cy={2} r={2.6} fill={C.bad} />}
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
