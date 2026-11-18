import { useState } from 'react';
import type { RunState } from '@synape/core';
import { billableTokens } from '@synape/core';
import { api, type ProvidersResponse } from '../api';
import { setLowPower, useStore, viewState } from '../store';
import { fmtDuration, fmtTokens } from '../util';

/** Top bar: run identity, controls and the live resource HUD. */
export function TopBar({ providers, onGit, onFleet, onSummary, onPaper }: { providers?: ProvidersResponse; onGit: () => void; onFleet: () => void; onSummary: () => void; onPaper: () => void }) {
  const s = useStore(viewState);
  useStore((x) => x.version);
  const runId = useStore((x) => x.runId);
  const connected = useStore((x) => x.connected);
  const lowPower = useStore((x) => x.lowPower);
  const cursor = useStore((x) => x.cursor);
  const [open, setOpen] = useState(false);
  if (!s || !runId) return null;
  const st = s.run.status;
  const active = Object.values(s.agents).filter((a) => a.status === 'running' || a.status === 'starting').length;
  const tasks = Object.values(s.tasks);
  const done = tasks.filter((t) => t.status === 'completed').length;
  const verified = tasks.filter((t) => t.verified && t.kind === 'work').length;
  const total = billableTokens(s.totals);
  const elapsed = (s.run.endedAt ?? (cursor !== null ? s.lastTs : Date.now())) - s.run.createdAt;
  return (
    <header className="topbar">
      <div className="row grow" style={{ minWidth: 0, gap: 12 }}>
        <span className={`run-status rs-${st}`}>
          <span className={`dot ${st === 'running' ? 'live' : ''}`} />
          {st}
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="display ellipsis run-title" title={s.run.objective}>
            {s.run.title}
          </div>
          <div className="mono faint ellipsis" style={{ fontSize: 10.5 }}>
            {s.run.workspace} · {fmtDuration(elapsed)} · {done}/{tasks.length} tasks · {verified} verified · {active} agents live {connected ? '' : '· reconnecting…'}
          </div>
        </div>
      </div>
      <button className="hud" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Resource usage">
        <HudStat label="tokens" value={fmtTokens(total)} />
        <HudStat label="cache read" value={fmtTokens(s.totals.cacheReadTokens)} />
        <HudStat label="agents" value={String(Object.values(s.agents).filter((a) => a.attempt > 0).length)} />
        <QuotaMini s={s} providers={providers} />
      </button>
      <div className="row" style={{ gap: 6 }}>
        {cursor === null && (st === 'running' || st === 'planning') && (
          <button className="btn sm" onClick={() => api.control(runId, 'pause')}>
            Pause
          </button>
        )}
        {cursor === null && (st === 'paused' || st === 'failed') && (
          <button className="btn sm ok" onClick={() => api.control(runId, 'resume')}>
            Resume
          </button>
        )}
        {cursor === null && !['completed', 'cancelled', 'failed'].includes(st) && (
          <button className="btn sm danger" onClick={() => confirm('Cancel this run and all running agents?') && api.control(runId, 'cancel')}>
            Cancel
          </button>
        )}
        <button className={`btn sm ${['completed', 'failed'].includes(st) ? 'primary' : 'ghost'}`} onClick={onSummary} title="Short end summary: the answer, what is verified, what failed">
          ★ Summary
        </button>
        <button className="btn sm ghost" onClick={onPaper} title="Manuscript PDF and figure provenance">
          ◫ Paper
        </button>
        <button className="btn sm ghost" onClick={onGit} title="Git & publication">
          ⑂ Git
        </button>
        <button className="btn sm ghost" onClick={onFleet} title="Providers & models">
          ◎ Fleet
        </button>
        <button className={`btn sm ghost ${lowPower ? 'on' : ''}`} onClick={() => setLowPower(!lowPower)} title="Low-power rendering: no particles or atmosphere">
          {lowPower ? '◐ Low power' : '◑ Full fx'}
        </button>
      </div>
      {open && <ResourcePanel s={s} onClose={() => setOpen(false)} />}
    </header>
  );
}

function HudStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="hud-stat">
      <span className="mono hud-v">{value}</span>
      <span className="hud-l">{label}</span>
    </span>
  );
}

function QuotaMini({ s }: { s: RunState; providers?: ProvidersResponse }) {
  const qs = Object.values(s.quotas);
  if (!qs.length) return null;
  return (
    <span className="hud-stat" title={qs.map((q) => `${q.provider} ${q.window}: ${q.utilization !== undefined ? Math.round(q.utilization * 100) + '%' : 'n/a'}`).join('\n')}>
      <span className="quota-bars">
        {qs.slice(0, 3).map((q) => (
          <span key={q.window} className="qbar">
            <i style={{ height: `${Math.max(6, (q.utilization ?? 0) * 100)}%` }} />
          </span>
        ))}
      </span>
      <span className="hud-l">quota</span>
    </span>
  );
}

function ResourcePanel({ s, onClose }: { s: RunState; onClose: () => void }) {
  const total = billableTokens(s.totals);
  const providers = Object.entries(s.usageByProvider);
  const byAgent = Object.values(s.agents)
    .map((a) => ({ a, tok: billableTokens(a.usage) }))
    .sort((x, y) => y.tok - x.tok)
    .slice(0, 12);
  const max = byAgent[0]?.tok || 1;
  const { budgets } = s.run.config;
  return (
    <div className="res-panel panel" role="dialog" aria-label="Resources">
      <div className="row">
        <div className="display" style={{ fontSize: 15, fontWeight: 600 }}>
          Resources
        </div>
        <span className="grow" />
        <button className="btn ghost sm" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="res-grid" style={{ margin: '10px 0' }}>
        <div className="metric">
          <div className="mono metric-v">{fmtTokens(total)}</div>
          <div className="metric-l">tokens (in+out+cache write)</div>
        </div>
        <div className="metric">
          <div className="mono metric-v">{fmtTokens(s.totals.cacheReadTokens)}</div>
          <div className="metric-l">cache read</div>
        </div>
        <div className="metric">
          <div className="mono metric-v">{total ? Math.round((s.totals.retryTokens / total) * 100) : 0}%</div>
          <div className="metric-l">retry overhead</div>
        </div>
        <div className="metric">
          <div className="mono metric-v">{total ? Math.round((s.totals.reviewTokens / total) * 100) : 0}%</div>
          <div className="metric-l">verification share</div>
        </div>
        <div className="metric">
          <div className="mono metric-v">{s.totals.duplicateRejected}</div>
          <div className="metric-l">duplicates prevented</div>
        </div>
        <div className="metric">
          <div className="mono metric-v">{budgets.maxTokens ? `${Math.round((total / budgets.maxTokens) * 100)}%` : '∞'}</div>
          <div className="metric-l">of token budget</div>
        </div>
      </div>
      {budgets.maxTokens && (
        <div className="bar" style={{ marginBottom: 12 }}>
          <i style={{ width: `${Math.min(100, (total / budgets.maxTokens) * 100)}%`, background: 'linear-gradient(90deg, var(--nucleus), var(--ion))' }} />
        </div>
      )}
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        By provider
      </div>
      {providers.map(([p, u]) => (
        <div key={p} className="row prov-row">
          <span className={`chip ${p === 'claude-code' ? 'ember' : p === 'codex' ? 'ion' : p === 'local' ? 'leaf' : ''}`}>{p}</span>
          <span className="mono">{fmtTokens(billableTokens(u))}</span>
          <span className="mono faint">+{fmtTokens(u.cacheReadTokens)} cached</span>
          <span className="grow" />
          <span className="mono" title={u.costBasis === 'api-list-equivalent' ? 'API list-price equivalent. Subscription usage: not billed per token.' : u.costBasis === 'unavailable' ? 'This provider does not report cost; none is estimated.' : 'Billed API usage'}>
            {u.costUsd !== undefined ? `$${u.costUsd.toFixed(3)}${u.costBasis === 'api-list-equivalent' ? ' list-eq.' : ''}` : 'cost n/a'}
          </span>
        </div>
      ))}
      {Object.values(s.quotas).length > 0 && (
        <>
          <div className="eyebrow" style={{ margin: '12px 0 6px' }}>
            Subscription windows (reported by provider)
          </div>
          {Object.values(s.quotas).map((q) => (
            <div key={q.provider + q.window} style={{ marginBottom: 6 }}>
              <div className="row mono faint" style={{ justifyContent: 'space-between', fontSize: 11 }}>
                <span>
                  {q.provider} · {q.window.replace('_', ' ')}
                </span>
                <span>
                  {q.utilization !== undefined ? `${Math.round(q.utilization * 100)}%` : 'n/a'}
                  {q.resetsAt ? ` · resets ${new Date(q.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                </span>
              </div>
              <div className="bar">
                <i style={{ width: `${(q.utilization ?? 0) * 100}%`, background: (q.utilization ?? 0) > 0.8 ? 'var(--bad)' : 'var(--ember)' }} />
              </div>
            </div>
          ))}
        </>
      )}
      <div className="eyebrow" style={{ margin: '12px 0 6px' }}>
        By agent
      </div>
      {byAgent.map(({ a, tok }) => (
        <div key={a.id} className="agent-bar">
          <span className="ellipsis" style={{ width: 150 }}>
            {s.tasks[a.taskId]?.title}
          </span>
          <span className="bar grow">
            <i style={{ width: `${(tok / max) * 100}%`, background: a.provider === 'codex' ? 'var(--ion)' : a.provider === 'local' ? 'var(--leaf)' : 'var(--ember)' }} />
          </span>
          <span className="mono" style={{ width: 52, textAlign: 'right' }}>
            {fmtTokens(tok)}
          </span>
        </div>
      ))}
      <p className="faint" style={{ fontSize: 11, marginTop: 10 }}>
        Token counts are reported by the provider CLIs. Claude Code reports an API list-price equivalent, which is not what a subscription bills. Codex reports no cost, so none is shown.
      </p>
    </div>
  );
}
