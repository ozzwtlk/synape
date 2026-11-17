import { memo } from 'react';
import { BaseEdge, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';

export type EdgeKind = 'tree' | 'dep' | 'review' | 'compute';
export interface SynapseEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  /** Work is actively flowing along this edge right now (real agent state). */
  live: boolean;
  /** A fresh signal (handoff/delegation/review/result event) just crossed it. */
  pulse: number; // 0 = none, otherwise a key that changes per signal
  pulseReverse?: boolean;
  color: string;
  verdict?: string;
  animate: boolean;
  dim: boolean;
}
export type SynapseFlowEdge = Edge<SynapseEdgeData, 'synapse'>;

/** Point where the ray from the orb's centre toward `to` leaves its rim. */
function border(n: InternalNode, to: { x: number; y: number }) {
  const w = n.measured.width ?? 60;
  const h = n.measured.height ?? 60;
  const cx = n.internals.positionAbsolute.x + w / 2;
  const cy = n.internals.positionAbsolute.y + h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  const len = Math.hypot(dx, dy);
  if (!len) return { x: cx, y: cy };
  const r = Math.min(w, h) / 2 + 4;
  return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
}
const center = (n: InternalNode) => ({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 200) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 60) / 2 });

function SynapseEdgeView({ id, source, target, data }: EdgeProps<SynapseFlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!data || !s || !t) return null;
  const a = border(s, center(t));
  const b = border(t, center(s));
  // Gentle arc: perpendicular offset proportional to length (tree edges arc more).
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = data.kind === 'tree' ? 0.12 : data.kind === 'dep' ? 0.06 : 0.0;
  if (data.kind === 'compute') {
    // A short tether; glows while the program runs.
    const p = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    return (
      <g className="syn-edge k-compute" opacity={data.dim ? 0.06 : 1}>
        <path d={p} fill="none" stroke={data.color} strokeOpacity={data.live ? 0.9 : 0.35} strokeWidth={data.live ? 1.6 : 1} strokeDasharray={data.live ? undefined : '2 3'} />
        {data.live && data.animate && <path d={p} fill="none" stroke={data.color} strokeWidth={2.4} className="syn-flow" strokeLinecap="round" />}
      </g>
    );
  }
  const mx = (a.x + b.x) / 2 - (dy / len) * len * bend;
  const my = (a.y + b.y) / 2 + (dx / len) * len * bend;
  const path = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
  const { kind, live, pulse, color, animate, dim } = data;
  const baseOpacity = dim ? 0.04 : kind === 'tree' ? 0.2 : kind === 'dep' ? 0.38 : 0.55;
  const width = kind === 'tree' ? 1.1 : kind === 'dep' ? 1.4 : 1.3;
  const kp = data.pulseReverse ? '1;0' : '0;1';
  return (
    <g className={`syn-edge k-${kind}`}>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={kind === 'dep' && !dim ? 'url(#syn-arrow)' : undefined}
        style={{ stroke: color, strokeOpacity: live ? Math.max(0.6, baseOpacity) : baseOpacity, strokeWidth: live ? width + 0.6 : width, strokeDasharray: kind === 'review' ? '4 4' : undefined }}
      />
      {live && animate && <path d={path} fill="none" stroke={color} strokeWidth={width + 1.4} strokeOpacity={0.85} className="syn-flow" strokeLinecap="round" />}
      {live && !animate && <path d={path} fill="none" stroke={color} strokeWidth={width + 2} strokeOpacity={0.25} />}
      {pulse > 0 && animate && (
        <g key={pulse}>
          {[
            { r: 9, fill: color, o: 0.35 },
            { r: 3.6, fill: '#fff', o: 1 },
          ].map((c, i) => (
            <circle key={i} r={c.r} fill={c.fill} opacity={0} className="syn-pulse">
              <animateMotion dur="1.1s" repeatCount="1" fill="freeze" path={path} keyPoints={kp} keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
              <animate attributeName="opacity" dur="1.1s" values={`0;${c.o};${c.o};0`} keyTimes="0;0.1;0.85;1" fill="freeze" />
            </circle>
          ))}
        </g>
      )}
    </g>
  );
}

export const SynapseEdge = memo(SynapseEdgeView);

/** Shared SVG defs (arrowhead), rendered once inside the flow's edge layer. */
export function EdgeDefs() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        <marker id="syn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="rgba(200,210,255,0.55)" />
        </marker>
      </defs>
    </svg>
  );
}
