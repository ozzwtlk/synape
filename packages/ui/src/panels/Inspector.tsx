import { useEffect, useMemo, useState } from 'react';
import type { Agent, Artifact, EventEnvelope, RunState, Task } from '@synape/core';
import { billableTokens } from '@synape/core';
import { api, type ProvidersResponse } from '../api';
import { select, useStore, viewState } from '../store';
import { KIND_LABEL, STATUS_LABEL, familyOfProvider, fmtDuration, fmtTime, fmtTokens, isActive, latestAgent } from '../util';
import { Diff, Markdown } from './Markdown';

type Tab = 'overview' | 'activity' | 'artifacts' | 'routing';

export function Inspector({ providers, onExpand, expanded }: { providers?: ProvidersResponse; onExpand: () => void; expanded: boolean }) {
  const s = useStore(viewState);
  useStore((x) => x.version);
  const selection = useStore((x) => x.selection);
  const runId = useStore((x) => x.runId);
  const [tab, setTab] = useState<Tab>('overview');
  const [agentId, setAgentId] = useState<string | null>(null);

  const task: Task | undefined = s && selection ? (selection.kind === 'task' ? s.tasks[selection.id] : s.tasks[s.agents[selection.id]?.taskId]) : undefined;
  useEffect(() => {
    if (selection?.kind === 'agent') setAgentId(selection.id);
    else setAgentId(null);
  }, [selection]);
  if (!s || !task || !runId) return null;
  const agents = task.agentIds.map((a) => s.agents[a]).filter(Boolean);
  const agent = (agentId && s.agents[agentId]) || latestAgent(s, task) || agents.at(-1);

  return (
    <aside className={`inspector panel ${expanded ? 'expanded' : ''}`} aria-label="Inspector">
      <header className="insp-head">
        <div className="row">
          <span className="eyebrow" style={{ color: task.kind === 'plan' || task.kind === 'orchestrate' ? 'var(--nucleus)' : undefined }}>
            {KIND_LABEL[task.kind]} · depth {task.depth}
          </span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={onExpand} title={expanded ? 'Collapse workspace' : 'Expand to workspace'}>
            {expanded ? '⇥' : '⇤'}
          </button>
          <button className="btn ghost sm" onClick={() => select(null)} aria-label="Close inspector">
            ✕
          </button>
        </div>
        <h2 className="display insp-title">{task.title}</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <StatusChip t={task} />
          {task.verified && <span className="chip ok">✓ independently verified</span>}
          {!task.verified && task.status === 'completed' && task.verification !== 'none' && task.kind === 'work' && <span className="chip warn">unverified</span>}
          <span className="chip">{task.category}</span>
          <span className="chip">c{task.complexity} · crit{task.criticality}</span>
          <span className="chip">{task.permission}</span>
          {task.verification !== 'none' && <span className="chip nucleus">{task.verification}</span>}
        </div>
        {agents.length > 0 && (
          <div className="agent-strip">
            {agents.map((a) => (
              <button key={a.id} className={`agent-pill fam-${familyOfProvider(a.provider)} ${a.id === agent?.id ? 'on' : ''}`} onClick={() => setAgentId(a.id)} title={`${a.role} · ${a.status}`}>
                <span className={`dot ${isActive(a) ? 'live' : ''}`} />
                {a.attempt === 0 ? 'Q&A' : `#${a.attempt}`} {a.modelId.split(':')[1]}
              </button>
            ))}
          </div>
        )}
        <div className="tabs" role="tablist">
          {(['overview', 'activity', 'artifacts', 'routing'] as Tab[]).map((t) => (
            <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'artifacts' ? `artifacts ${task.artifactIds.length || ''}` : t}
            </button>
          ))}
        </div>
      </header>
      <div className="insp-body scroll">
        {tab === 'overview' && <Overview s={s} t={task} agent={agent} runId={runId} providers={providers} />}
        {tab === 'activity' && agent && <Activity runId={runId} agent={agent} expanded={expanded} />}
        {tab === 'activity' && !agent && <p className="faint">No agent has run this task yet.</p>}
        {tab === 'artifacts' && <Artifacts s={s} t={task} runId={runId} />}
        {tab === 'routing' && <Routing t={task} providers={providers} />}
      </div>
    </aside>
  );
}

function StatusChip({ t }: { t: Task }) {
  const tone = t.status === 'failed' ? 'bad' : t.status === 'completed' ? 'ok' : t.status === 'blocked' ? 'warn' : t.status === 'running' || t.status === 'awaiting_review' || t.status === 'delegated' ? 'nucleus' : '';
  return (
    <span className={`chip ${tone}`}>
      {(t.status === 'running' || t.status === 'delegated') && <span className="dot live" />}
      {STATUS_LABEL[t.status]}
    </span>
  );
}

function TaskLink({ s, id }: { s: RunState; id: string }) {
  const t = s.tasks[id];
  if (!t) return null;
  return (
    <button className="chip clickable" onClick={() => select({ kind: 'task', id }, true)}>
      <span className="dot" style={{ color: t.status === 'completed' ? 'var(--ok)' : t.status === 'failed' ? 'var(--bad)' : 'var(--idle)' }} />
      {t.title}
    </button>
  );
}

function Overview({ s, t, agent, runId, providers }: { s: RunState; t: Task; agent?: Agent; runId: string; providers?: ProvidersResponse }) {
  const children = Object.values(s.tasks).filter((x) => x.parentTaskId === t.id);
  const dependants = Object.values(s.tasks).filter((x) => x.deps.includes(t.id));
  const reviews = t.reviewIds.map((r) => s.reviews[r]).filter(Boolean);
  const parentAgent = agent?.parentAgentId ? s.agents[agent.parentAgentId] : undefined;
  const esc = s.escalations.filter((e) => e.taskId === t.id);
  const u = t.usage;
  const ctxFrac = agent?.usage.peakContextTokens && agent.usage.contextWindow ? agent.usage.peakContextTokens / agent.usage.contextWindow : undefined;
  return (
    <div className="col" style={{ gap: 14 }}>
      <section>
        <div className="eyebrow">Objective</div>
        <p className="objective">{t.objective}</p>
        {t.acceptance.length > 0 && (
          <ul className="accept">
            {t.acceptance.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        )}
      </section>
      {t.resultSummary && (
        <section className="card result">
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Result
          </div>
          <Markdown text={t.resultSummary} />
        </section>
      )}
      {t.statusReason && (
        <div className={`note ${t.status === 'failed' ? 'bad' : ''}`}>
          <span className="faint">status:</span> {t.statusReason}
        </div>
      )}
      {reviews.length > 0 && (
        <section className="col">
          <div className="eyebrow">Independent reviews</div>
          {reviews.map((r) => {
            const rev = s.agents[r.reviewerAgentId];
            return (
              <div key={r.id} className={`card verdict v-${r.verdict}`}>
                <div className="row">
                  <span className={`chip ${r.verdict === 'pass' ? 'ok' : r.verdict === 'revise' ? 'warn' : 'bad'}`}>{r.verdict}</span>
                  <span className="mono faint">conf {r.confidence.toFixed(2)}</span>
                  <span className="grow" />
                  <button className={`chip clickable fam-chip-${familyOfProvider(rev?.provider)}`} onClick={() => rev && select({ kind: 'task', id: rev.taskId }, true)}>
                    {rev?.modelId}
                  </button>
                </div>
                <p style={{ margin: '6px 0 0' }}>{r.summary}</p>
                {r.issues.length > 0 && (
                  <ul className="issues">
                    {r.issues.map((i, k) => (
                      <li key={k} className={`sev-${i.severity}`}>
                        <b>{i.severity}</b> {i.description}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      )}
      <section>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Agent
        </div>
        {agent ? (
          <dl className="kv">
            <dt>model</dt>
            <dd className={`mono fam-text-${familyOfProvider(agent.provider)}`}>{agent.modelId}</dd>
            <dt>role</dt>
            <dd>{agent.role.replace('_', '-')}</dd>
            <dt>state</dt>
            <dd>
              {agent.status}
              {agent.statusReason ? <span className="faint"> — {agent.statusReason}</span> : null}
            </dd>
            <dt>parent</dt>
            <dd>{parentAgent ? <TaskLink s={s} id={parentAgent.taskId} /> : <span className="faint">user</span>}</dd>
            <dt>session</dt>
            <dd className="mono faint ellipsis">{agent.sessionId ?? '—'}</dd>
            <dt>elapsed</dt>
            <dd className="mono">{fmtDuration((agent.endedAt ?? s.lastTs) - agent.startedAt)}</dd>
          </dl>
        ) : (
          <p className="faint">Not started.</p>
        )}
      </section>
      <section>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Resources (this task, all attempts)
        </div>
        <div className="res-grid">
          <Metric label="input" value={fmtTokens(u.inputTokens)} />
          <Metric label="output" value={fmtTokens(u.outputTokens)} />
          <Metric label="cache read" value={fmtTokens(u.cacheReadTokens)} />
          <Metric label="cache write" value={fmtTokens(u.cacheWriteTokens)} />
          <Metric label="reasoning" value={fmtTokens(u.reasoningTokens)} />
          <Metric label="cost" value={u.costUsd !== undefined ? `$${u.costUsd.toFixed(3)}` : 'n/a'} hint={u.costBasis === 'api-list-equivalent' ? 'API list-price equivalent; subscription, not billed' : u.costBasis === 'unavailable' ? 'provider reports no cost' : 'billed'} />
        </div>
        {ctxFrac !== undefined && (
          <div style={{ marginTop: 8 }}>
            <div className="row mono faint" style={{ justifyContent: 'space-between' }}>
              <span>peak context</span>
              <span>
                {fmtTokens(agent!.usage.peakContextTokens)} / {fmtTokens(agent!.usage.contextWindow)}
              </span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.max(1, ctxFrac * 100)}%`, background: ctxFrac > 0.7 ? 'var(--warn)' : 'var(--nucleus)' }} />
            </div>
          </div>
        )}
        {agent && agent.usage.peakContextTokens === undefined && <p className="faint mono" style={{ fontSize: 11 }}>context utilization not reported by {agent.provider}</p>}
      </section>
      {esc.length > 0 && (
        <section>
          <div className="eyebrow">Escalations</div>
          {esc.map((e, i) => (
            <div key={i} className="note">
              <span className="mono">⇑ from {e.from}</span> — {e.reason}
            </div>
          ))}
        </section>
      )}
      {(t.deps.length > 0 || dependants.length > 0 || children.length > 0 || t.reviewOf) && (
        <section className="col">
          {t.reviewOf && (
            <div>
              <div className="eyebrow">Reviews</div>
              <TaskLink s={s} id={t.reviewOf} />
            </div>
          )}
          {t.deps.length > 0 && (
            <div>
              <div className="eyebrow">Depends on</div>
              <div className="links">{t.deps.map((d) => <TaskLink key={d} s={s} id={d} />)}</div>
            </div>
          )}
          {dependants.length > 0 && (
            <div>
              <div className="eyebrow">Feeds</div>
              <div className="links">{dependants.map((d) => <TaskLink key={d.id} s={s} id={d.id} />)}</div>
            </div>
          )}
          {children.length > 0 && (
            <div>
              <div className="eyebrow">Delegated</div>
              <div className="links">{children.map((d) => <TaskLink key={d.id} s={s} id={d.id} />)}</div>
            </div>
          )}
        </section>
      )}
      <ModelPicker runId={runId} t={t} providers={providers} />
      <section className="row" style={{ flexWrap: 'wrap' }}>
        {!['completed', 'failed', 'cancelled'].includes(t.status) && (
          <button className="btn danger sm" onClick={() => api.task(runId, t.id, 'cancel')}>
            Cancel task{children.length ? ' + subtree' : ''}
          </button>
        )}
        {['failed', 'cancelled', 'completed', 'blocked'].includes(t.status) && t.kind === 'work' && (
          <button className="btn sm" onClick={() => api.task(runId, t.id, 'retry')}>
            Retry
          </button>
        )}
      </section>
    </div>
  );
}

/** Override the router: pin this task to a model (or back to Auto). */
function ModelPicker({ runId, t, providers }: { runId: string; t: Task; providers?: ProvidersResponse }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const models = (providers?.models ?? []).filter((m) => m.available || m.id === t.pinnedModel);
  const restarts = t.status === 'running' ? ' (restarts the running agent)' : ['completed', 'failed', 'cancelled'].includes(t.status) && t.kind !== 'plan' && t.kind !== 'orchestrate' ? ' (re-runs the task)' : '';
  return (
    <section>
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Model
      </div>
      <div className="row">
        <select
          className="input"
          aria-label="Model for this task"
          disabled={busy}
          value={t.pinnedModel ?? ''}
          onChange={async (e) => {
            setErr('');
            setBusy(true);
            try {
              await api.setTaskModel(runId, t.id, e.target.value || null);
            } catch (x) {
              setErr((x as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Auto (router decides)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.effort ? ` · ${m.effort}` : ''}
            </option>
          ))}
        </select>
      </div>
      <p className="faint" style={{ fontSize: 11, margin: '4px 0 0' }}>
        {t.pinnedModel ? 'Pinned by you; routing gates are bypassed.' : 'Pick a model to override the router'}
        {restarts}
      </p>
      {err && <p style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</p>}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <div className="mono metric-v">{value}</div>
      <div className="metric-l">{label}</div>
    </div>
  );
}

function Activity({ runId, agent, expanded }: { runId: string; agent: Agent; expanded: boolean }) {
  const [log, setLog] = useState<EventEnvelope[] | null>(null);
  const live = useStore((x) => x.live);
  useStore((x) => x.version);
  const cursor = useStore((x) => x.cursor);
  useEffect(() => {
    let alive = true;
    setLog(null);
    api.agentLog(runId, agent.id).then((l) => alive && setLog(l));
    return () => {
      alive = false;
    };
  }, [runId, agent.id, isActive(agent) ? Math.floor(agent.lastActivity / 2500) : agent.status]);
  const lines = useMemo(() => {
    const evs = (log ?? []).filter((e) => cursor === null || e.seq <= cursor);
    return evs.map((e) => {
      const b = e.body as any;
      switch (b.type) {
        case 'tool.started':
          return { k: e.seq, cls: 't-tool', text: `⟡ ${b.name} ${b.input}`, ts: e.ts };
        case 'tool.finished':
          return { k: e.seq, cls: b.ok ? 't-ok' : 't-err', text: `  ${b.ok ? '✓' : '✗'} ${b.output.slice(0, expanded ? 2000 : 400)}`, ts: e.ts };
        case 'agent.output':
          return { k: e.seq, cls: b.stream === 'stderr' ? 't-err' : b.stream === 'system' ? 't-sys' : b.stream === 'thinking' ? 't-think' : '', text: b.text, ts: e.ts };
        case 'agent.status':
          return { k: e.seq, cls: 't-sys', text: `── ${b.status}${b.reason ? `: ${b.reason}` : ''}`, ts: e.ts };
        case 'error':
          return { k: e.seq, cls: 't-err', text: `! ${b.message}`, ts: e.ts };
        default:
          return null;
      }
    }).filter(Boolean) as { k: number; cls: string; text: string; ts: number }[];
  }, [log, cursor, expanded]);
  void live;
  return (
    <div className="col">
      <div className="row mono faint" style={{ fontSize: 11 }}>
        <span>{agent.toolCount} tool calls</span>·<span>{fmtTokens(billableTokens(agent.usage))} tokens</span>
        <span className="grow" />
        {isActive(agent) && (
          <span className="chip nucleus">
            <span className="dot live" />
            live
          </span>
        )}
      </div>
      <div className="terminal" style={{ maxHeight: expanded ? 'none' : 520 }} role="log" aria-live="polite">
        {log === null && <span className="t-sys">loading…</span>}
        {lines.map((l) => (
          <div key={l.k} className={l.cls}>
            <span className="t-sys">{fmtTime(l.ts)} </span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Artifacts({ s, t, runId }: { s: RunState; t: Task; runId: string }) {
  const arts = t.artifactIds.map((a) => s.artifacts[a]).filter(Boolean) as Artifact[];
  // Delegated tasks: surface their synthesis report too.
  const synth = Object.values(s.tasks).filter((x) => x.parentTaskId === t.id && x.kind === 'synthesize').flatMap((x) => x.artifactIds.map((a) => s.artifacts[a]).filter(Boolean));
  const all = [...arts, ...synth];
  const [open, setOpen] = useState<string | null>(all.at(-1)?.id ?? null);
  const [content, setContent] = useState<string>('');
  useEffect(() => {
    if (!open) return;
    setContent('');
    api.artifact(runId, open).then(setContent).catch((e) => setContent(`(could not load: ${e.message})`));
  }, [open, runId]);
  if (!all.length) return <p className="faint">No artifacts yet.</p>;
  const cur = all.find((a) => a.id === open);
  return (
    <div className="col">
      <div className="links">
        {all.map((a) => (
          <button key={a.id} className={`chip clickable ${a.id === open ? 'nucleus' : ''}`} onClick={() => setOpen(a.id)}>
            {a.kind} · {fmtTokens(a.bytes)}B
          </button>
        ))}
      </div>
      {cur && <div className="mono faint ellipsis" title={cur.path}>{cur.path}</div>}
      {cur && (cur.kind === 'diff' ? <Diff text={content} /> : cur.kind === 'plan' || cur.kind === 'verdict' ? <pre className="terminal">{content}</pre> : <Markdown text={content} />)}
    </div>
  );
}

function Routing({ t, providers }: { t: Task; providers?: ProvidersResponse }) {
  const r = t.routing;
  if (!r) return <p className="faint">Not routed yet.</p>;
  const label = (id: string) => providers?.models.find((m) => m.id === id)?.label ?? id;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Why this model
        </div>
        <div style={{ lineHeight: 1.6 }}>
          {r.explanation.split('\n').map((p, i) => (
            <div key={i} className={i === 0 ? 'display' : 'mono'} style={i === 0 ? { fontSize: 14 } : { fontSize: 11, color: 'var(--text-2)' }}>
              {p}
            </div>
          ))}
        </div>
      </div>
      {r.candidates.length > 0 && (
        <table className="cand">
          <thead>
            <tr>
              <th>model</th>
              <th title="Posterior mean P(success): catalog prior + local history">P</th>
              <th title="Expected total cost per verified result (RU)">E[RU]</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.candidates.map((c) => (
              <tr key={c.modelId} className={c.modelId === r.modelId ? 'pick' : c.eligible ? '' : 'rej'}>
                <td className="ellipsis">{label(c.modelId)}</td>
                <td className="mono">
                  {c.pSuccess.toFixed(2)}
                  {c.samples ? <span className="faint"> n{c.samples}</span> : null}
                </td>
                <td className="mono">{Math.round(c.expected.total)}</td>
                <td className="faint" style={{ fontSize: 10.5 }}>{c.modelId === r.modelId ? '◀ chosen' : c.rejectedBecause ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <div className="eyebrow">Assumptions</div>
        <ul className="accept">
          {r.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
          <li>Estimated tokens for this task: {fmtTokens(r.estTokens)}</li>
        </ul>
      </div>
    </div>
  );
}
