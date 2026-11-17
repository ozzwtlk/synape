import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, MiniMap, Controls, Panel, useReactFlow, type Node, type NodeMouseHandler } from '@xyflow/react';
import type { RunState, Task } from '@synape/core';
import { C, ComputeNode, TaskNode, type ComputeFlowNode, type KidMark, type TaskFlowNode } from './TaskNode';
import { EdgeDefs, SynapseEdge, type SynapseFlowEdge } from './SynapseEdge';
import { Starfield } from './Starfield';
import { computeId, layout, orbitRings, visibleTasks, type LayoutMode } from './layout';
import { getStore, select, useStore, viewState } from '../store';
import { familyOfProvider, isActive, latestAgent, programColor, tokensOf } from '../util';

function OrbitTrack({ data }: { data: { r: number; live: boolean; dim: boolean } }) {
  const d = data.r * 2;
  return (
    <svg width={d} height={d} style={{ overflow: 'visible', pointerEvents: 'none', opacity: data.dim ? 0.15 : 1 }} aria-hidden>
      <circle cx={data.r} cy={data.r} r={data.r} className={`orbit-track ${data.live ? 'live' : ''}`} />
    </svg>
  );
}
const nodeTypes = { task: TaskNode, compute: ComputeNode, orbit: OrbitTrack };
const edgeTypes = { synapse: SynapseEdge };
const PULSE_MS = 1400;

const famColor = (p?: string) => (familyOfProvider(p) === 'anthropic' ? '#ff9f6e' : familyOfProvider(p) === 'openai' ? '#5ee7ff' : '#8b95c9');

function neighborhood(s: RunState, id: string): Set<string> {
  const out = new Set([id]);
  const t = s.tasks[id];
  if (!t) return out;
  let p = t.parentTaskId;
  while (p) {
    out.add(p);
    p = s.tasks[p]?.parentTaskId;
  }
  const down = [id];
  while (down.length) {
    const x = down.pop()!;
    for (const k of Object.values(s.tasks)) if (k.parentTaskId === x || k.reviewOf === x) (out.add(k.id), down.push(k.id));
  }
  for (const d of t.deps) out.add(d);
  for (const k of Object.values(s.tasks)) if (k.deps.includes(id)) out.add(k.id);
  if (t.reviewOf) out.add(t.reviewOf);
  return out;
}

export function Graph() {
  const state = useStore(viewState);
  const version = useStore((s) => s.version);
  const selection = useStore((s) => s.selection);
  const focusSeq = useStore((s) => s.focusSeq);
  const cursor = useStore((s) => s.cursor);
  const lowPower = useStore((s) => s.lowPower);
  const reduced = useStore((s) => s.reducedMotion);
  const animate = !lowPower && !reduced;
  const [mode, setMode] = useState<LayoutMode>('orbit');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusMode, setFocusMode] = useState(false);
  const rf = useReactFlow();
  const [tick, setTick] = useState(0);

  const toggle = useCallback((id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  }), []);

  const selectedTaskId = selection ? (selection.kind === 'task' ? selection.id : state?.agents[selection.id]?.taskId) : undefined;

  const { nodes, edges, activeCount, structureKey, rings } = useMemo(() => {
    if (!state) return { nodes: [] as (TaskFlowNode | ComputeFlowNode)[], edges: [] as SynapseFlowEdge[], activeCount: 0, structureKey: '', rings: [] as { id: string; x: number; y: number; r: number; live: boolean; dim: boolean }[] };
    const tasks = visibleTasks(state, collapsed);
    const pos = layout(tasks, mode);
    const visible = new Set(tasks.map((t) => t.id));
    const near = focusMode && selectedTaskId ? neighborhood(state, selectedTaskId) : null;
    const childCount = new Map<string, number>();
    const kidsOf = new Map<string, KidMark[]>();
    for (const t of Object.values(state.tasks)) {
      if (!t.parentTaskId) continue;
      childCount.set(t.parentTaskId, (childCount.get(t.parentTaskId) ?? 0) + 1);
      if (t.kind === 'review') continue;
      const ka = latestAgent(state, t);
      const kfam = familyOfProvider(ka?.provider);
      const color = t.kind === 'orchestrate' ? C.nucleus : kfam === 'anthropic' ? C.ember : kfam === 'openai' ? C.ion : C.idle;
      kidsOf.set(t.parentTaskId, [...(kidsOf.get(t.parentTaskId) ?? []), { id: t.id, status: t.status, verified: t.verified, color, tokens: tokensOf(t.usage), live: isActive(ka) }]);
    }
    const FIG = /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i;
    let activeCount = 0;
    const nodes: (TaskFlowNode | ComputeFlowNode)[] = tasks.map((t): TaskFlowNode => {
      const a = latestAgent(state, t);
      if (isActive(a)) activeCount++;
      const running = a && isActive(a) ? a.toolCalls.filter((c) => !c.endedAt).map((c) => c.name) : [];
      const activeTools = running.length ? running.join(', ') : isActive(a) && a?.toolCalls.length ? `${a.toolCalls.at(-1)!.name} · ${a.toolCount} tools` : null;
      const dim = !!near && !near.has(t.id);
      const kids = kidsOf.get(t.id) ?? [];
      const figures = (t.outputs ?? []).filter((f) => FIG.test(f.rel)).length;
      const sig = [kids.map((k) => `${k.status[0]}${k.live ? 1 : 0}${k.verified ? 1 : 0}${Math.round(Math.log2(1 + k.tokens))}`).join(''), figures, a?.endedAt, Object.keys(t.computes ?? {}).length, t.status, t.verified, t.attempts, tokensOf(t.usage), a?.id, a?.status, a?.toolCount, a?.usage.peakContextTokens, activeTools, collapsed.has(t.id), childCount.get(t.id), dim, t.title, t.resultSummary?.slice(0, 12)].join('|');
      return {
        id: t.id,
        type: 'task',
        position: pos.get(t.id)!,
        data: { task: t, agent: a, kids, figures, childCount: childCount.get(t.id) ?? 0, collapsed: collapsed.has(t.id), activeTools, sig, dim, animate, onToggle: toggle },
        selected: t.id === selectedTaskId,
      };
    });
    // Computations (Python, Wolfram, MadGraph…) as small satellites of their task.
    for (const t of tasks) {
      for (const stat of Object.values(t.computes ?? {})) {
        const id = computeId(t.id, stat.program);
        const p = pos.get(id);
        if (!p) continue;
        const dim = !!near && !near.has(t.id);
        nodes.push({ id, type: 'compute', position: p, data: { taskId: t.id, stat, dim, animate, sig: [stat.runs, stat.running, stat.ok, stat.failed, dim].join('|') }, selectable: false, zIndex: 2 });
      }
    }

    // Fresh signals → pulses along the corresponding edge.
    const store = getStore();
    const now = performance.now();
    const pulses = new Map<string, number>();
    const taskOf = (x: string) => state.agents[x]?.taskId ?? (state.tasks[x] ? x : undefined);
    for (const sg of state.signals) {
      const fresh = cursor !== null ? sg.seq > cursor - 25 : now - (store.signalTimes.get(sg.seq) ?? 0) < PULSE_MS;
      if (!fresh) continue;
      const a = taskOf(sg.from);
      const b = taskOf(sg.to);
      if (!a || !b || a === b) continue;
      pulses.set(`${a}>${b}`, sg.seq);
    }

    const edges: SynapseFlowEdge[] = [];
    const add = (id: string, source: string, target: string, kind: 'tree' | 'dep' | 'review' | 'compute', live: boolean, color: string, extra: Partial<SynapseFlowEdge['data']> = {}) => {
      if (!visible.has(source) || !visible.has(target)) return;
      const dim = !!near && !(near.has(source) && near.has(target));
      const fwd = pulses.get(`${source}>${target}`);
      const rev = pulses.get(`${target}>${source}`);
      edges.push({ id, source, target, type: 'synapse', data: { kind, live, pulse: fwd ?? rev ?? 0, pulseReverse: !fwd && !!rev, color, animate, dim, ...extra } as any, zIndex: kind === 'tree' ? 0 : 1 });
    };
    for (const t of tasks) {
      const a = latestAgent(state, t);
      if (t.parentTaskId && t.kind !== 'review') {
        const depsVisible = t.deps.some((d) => visible.has(d) && state.tasks[d]?.parentTaskId === t.parentTaskId);
        // Children that also have sibling deps get only a faint tree edge.
        add(`h:${t.id}`, t.parentTaskId, t.id, 'tree', isActive(a), depsVisible ? '#6f7bb3' : '#9a8cff');
      }
      for (const d of t.deps) {
        if (t.kind === 'review') continue;
        const src = state.tasks[d];
        add(`d:${d}>${t.id}`, d, t.id, 'dep', isActive(a) && src?.status === 'completed', famColor(latestAgent(state, src ?? t)?.provider));
      }
      for (const stat of Object.values(t.computes ?? {})) {
        const cid = computeId(t.id, stat.program);
        visible.add(cid);
        add(`c:${cid}`, t.id, cid, 'compute', stat.running > 0, programColor(stat.program));
      }
      if (t.reviewOf) {
        const v = t.resultSummary?.split(' ')[0];
        const color = v === 'pass' ? '#6dffb3' : v === 'revise' ? '#ffd36b' : v === 'fail' ? '#ff5c7a' : '#cfd6ff';
        add(`r:${t.id}`, t.reviewOf, t.id, 'review', isActive(a), color, { verdict: v });
      }
    }
    const structureKey = `${mode}|${tasks.length}|${[...collapsed].join(',')}`;
    const rings = [...orbitRings].map(([id, r]) => ({ id, ...r, live: tasks.some((k) => k.parentTaskId === id && isActive(latestAgent(state, k))), dim: !!near && !near.has(id) }));
    return { nodes, edges, activeCount, structureKey, rings };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, version, collapsed, mode, selectedTaskId, focusMode, animate, cursor, tick, toggle]);

  // Expire pulses after their animation (cheap re-derive).
  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setTick((x) => x + 1), PULSE_MS + 50);
    return () => clearTimeout(t);
  }, [version, animate]);

  // Fit when structure changes.
  const lastStructure = useRef('');
  useEffect(() => {
    if (!nodes.length || structureKey === lastStructure.current) return;
    const first = !lastStructure.current;
    lastStructure.current = structureKey;
    requestAnimationFrame(() => {
      void rf.fitView({ padding: 0.34, duration: first || !animate ? 0 : 600, maxZoom: 1.1 });
    });
  }, [structureKey, nodes.length, rf, animate]);

  useEffect(() => {
    if (!focusSeq || !selectedTaskId) return;
    rf.fitView({ nodes: [{ id: selectedTaskId }], padding: 1.4, duration: animate ? 600 : 0, maxZoom: 1.25 });
  }, [focusSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const allNodes = useMemo(() => {
    if (mode !== 'orbit') return nodes as Node[];
    const tracks: Node[] = rings.map((r) => ({ id: `orbit:${r.id}`, type: 'orbit', position: { x: r.x - r.r, y: r.y - r.r }, data: r, selectable: false, draggable: false, focusable: false, zIndex: -1, style: { pointerEvents: 'none' } }));
    return [...tracks, ...(nodes as Node[])];
  }, [nodes, rings, mode]);

  const onNodeClick: NodeMouseHandler = useCallback((_, n) => {
    if (n.type === 'task') select({ kind: 'task', id: n.id });
    else if (n.type === 'compute') select({ kind: 'task', id: (n.data as ComputeFlowNode['data']).taskId });
  }, []);

  if (!state) return <div className="graph-empty" />;
  return (
    <div className={`graph ${animate ? 'animated' : 'static'}`}>
      <Starfield activity={activeCount} enabled={animate} />
      <EdgeDefs />
      <ReactFlow
        nodes={allNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => select(null)}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        minZoom={0.08}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={nodes.length > 120}
        fitView
      >
        <MiniMap style={{ width: 170, height: 110 }}
          pannable
          zoomable
          className="minimap"
          maskColor="rgba(3,5,11,0.72)"
          nodeColor={(n) => {
            if (n.type === 'compute') return programColor((n.data as ComputeFlowNode['data']).stat.program);
            if (n.type !== 'task') return 'transparent';
            const d = n.data as TaskFlowNode['data'];
            if (d.task.status === 'failed') return '#ff5c7a';
            if (d.task.kind === 'plan' || d.task.kind === 'orchestrate') return '#b8a6ff';
            return famColor(d.agent?.provider);
          }}
          nodeStrokeWidth={0}
          nodeBorderRadius={99}
        />
        <Controls showInteractive={false} className="controls" />
        <Panel position="top-left" className="graph-tools">
          <div className="tabs" role="tablist" aria-label="Layout">
            <button className="tab" role="tab" aria-selected={mode === 'orbit'} onClick={() => setMode('orbit')}>
              Orbit
            </button>
            <button className="tab" role="tab" aria-selected={mode === 'flow'} onClick={() => setMode('flow')}>
              Flow
            </button>
          </div>
          <button className={`btn sm ${focusMode ? 'primary' : ''}`} onClick={() => setFocusMode((f) => !f)} title="Dim everything outside the selected task's neighbourhood">
            Focus
          </button>
          {collapsed.size > 0 && (
            <button className="btn sm ghost" onClick={() => setCollapsed(new Set())}>
              Expand all
            </button>
          )}
        </Panel>
        <Panel position="top-right" className="legend">
          <span>
            <i style={{ background: 'var(--nucleus)' }} /> orchestration
          </span>
          <span>
            <i style={{ background: 'var(--ember)' }} /> Claude Code
          </span>
          <span>
            <i style={{ background: 'var(--ion)' }} /> Codex
          </span>
          <span>
            <i className="ring" /> ring = context used
          </span>
          <span>
            <i className="sat" /> satellites = computations (color by program)
          </span>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export const taskLabel = (t?: Task) => t?.title ?? '?';
