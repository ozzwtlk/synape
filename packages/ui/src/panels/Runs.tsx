import { useEffect, useState } from 'react';
import type { PermissionLevel } from '@synape/core';
import { api, home, type ProvidersResponse, type RunSummary } from '../api';
import { openRun, useStore } from '../store';
import { fmtTime } from '../util';

export function RunList({ runs, onNew }: { runs: RunSummary[]; onNew: () => void }) {
  const runId = useStore((x) => x.runId);
  return (
    <nav className="runlist" aria-label="Runs">
      <div className="brand row">
        <img src="/synape.svg" width={26} height={26} alt="" />
        <span className="display brand-name">synape</span>
      </div>
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onNew}>
        + New mission
      </button>
      <div className="eyebrow" style={{ margin: '14px 4px 6px' }}>
        Runs
      </div>
      <div className="scroll grow">
        {runs.map((r) => (
          <button key={r.id} className={`run-item ${r.id === runId ? 'on' : ''}`} onClick={() => openRun(r.id)}>
            <span className={`dot ${r.status === 'running' ? 'live' : ''} rs-dot-${r.status}`} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ellipsis run-item-title">{r.title}</span>
              <span className="mono faint" style={{ fontSize: 10 }}>
                {r.status} · {new Date(r.createdAt).toLocaleDateString()} {fmtTime(r.createdAt)}
              </span>
            </span>
          </button>
        ))}
        {!runs.length && <p className="faint" style={{ padding: 8 }}>No runs yet.</p>}
      </div>
    </nav>
  );
}

const EXAMPLES = [
  {
    label: 'Code audit',
    text: 'Audit this repository for correctness bugs in its core modules. Fix confirmed bugs, add regression tests, run them, and verify independently.',
    ceiling: 'execute' as PermissionLevel,
  },
  {
    label: 'Literature novelty',
    text: 'Survey the literature in `references/` and compare our results against it (search the web when necessary): decide which results are genuinely new, which overlap, and which are already established. Where possible, compare our numbers quantitatively with published calculations. Cross-check major conclusions independently and keep exact citations. It is acceptable to conclude that nothing is new.',
    ceiling: 'network' as PermissionLevel,
  },
  {
    label: 'Data analysis',
    text: 'Analyze the datasets in this workspace: document provenance, implement reproducible transformations as scripts, compute summary statistics, and validate every reported number independently.',
    ceiling: 'execute' as PermissionLevel,
  },
];

export function NewRun({ onClose, providers }: { onClose: () => void; providers?: ProvidersResponse }) {
  const [objective, setObjective] = useState('');
  const [workspace, setWorkspace] = useState(home);
  const [extra, setExtra] = useState('');
  const [ceiling, setCeiling] = useState<PermissionLevel>('read');
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxAgents, setMaxAgents] = useState(6);
  const [maxTokens, setMaxTokens] = useState(3_000_000);
  const [quality, setQuality] = useState(0.5);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [browse, setBrowse] = useState<{ path: string; parent: string | null; entries: string[] } | null>(null);
  const [repo, setRepo] = useState<Awaited<ReturnType<typeof api.git>> | null>(null);
  const avail = providers?.providers.filter((p) => p.available).map((p) => p.id) ?? [];
  useEffect(() => {
    setAllowed(avail);
  }, [providers]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => api.git(workspace).then(setRepo).catch(() => setRepo(null)), 300);
    return () => clearTimeout(t);
  }, [workspace]);

  const start = async () => {
    setErr('');
    try {
      const { runId } = await api.createRun({
        objective,
        workspace,
        config: {
          permissionCeiling: ceiling,
          extraDirs: extra.split('\n').map((x) => x.trim()).filter(Boolean),
          providers: allowed,
          qualityBias: quality,
          limits: { maxDepth, maxConcurrentAgents: maxAgents },
          budgets: { maxTokens },
        },
      });
      await openRun(runId);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel newrun" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New mission">
        <div className="row">
          <h2 className="display" style={{ margin: 0, fontSize: 20 }}>
            New mission
          </h2>
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="faint" style={{ marginTop: 4 }}>
          Describe the objective. The orchestrator plans a task graph, routes each task to the most efficient capable model across your providers, and verifies important results independently.
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {EXAMPLES.map((e) => (
            <button key={e.label} className="chip clickable" onClick={() => (setObjective(e.text), setCeiling(e.ceiling))}>
              {e.label}
            </button>
          ))}
        </div>
        <textarea className="textarea" rows={7} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Here is my research project. Analyze it, find what remains to be done, organize specialist agents, perform the work, cross-check everything, and return the results." autoFocus />
        <div className="grid2">
          <label className="col field">
            <span className="eyebrow">Workspace</span>
            <div className="row">
              <input className="input mono" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
              <button className="btn sm" onClick={() => api.fs(workspace).then(setBrowse).catch(() => api.fs().then(setBrowse))}>
                Browse
              </button>
            </div>
            <span className="mono faint" style={{ fontSize: 10.5 }}>
              {repo?.isRepo ? `git: ${repo.branch} @ ${repo.head}${repo.dirty ? ` · ${repo.dirty} modified` : ''} · writes go to isolated worktrees` : 'not a git repo: write tasks run serially in place'}
            </span>
            {browse && (
              <div className="browser scroll">
                {browse.parent && (
                  <button className="run-item" onClick={() => api.fs(browse.parent!).then(setBrowse)}>
                    ..
                  </button>
                )}
                {browse.entries.map((e) => (
                  <button
                    key={e}
                    className="run-item"
                    onClick={() => {
                      const p = `${browse.path}/${e}`;
                      setWorkspace(p);
                      api.fs(p).then(setBrowse);
                    }}
                  >
                    📁 {e}
                  </button>
                ))}
              </div>
            )}
          </label>
          <label className="col field">
            <span className="eyebrow">Extra readable directories (one per line)</span>
            <textarea className="textarea mono" rows={2} style={{ minHeight: 54 }} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="/path/to/shared/data" />
          </label>
          <label className="col field">
            <span className="eyebrow">Permission ceiling (higher needs approval)</span>
            <select className="select" value={ceiling} onChange={(e) => setCeiling(e.target.value as PermissionLevel)}>
              <option value="read">read: analysis only</option>
              <option value="write">write: edit files (in worktrees)</option>
              <option value="execute">execute: run commands and tests</option>
              <option value="network">network: web search and fetch</option>
            </select>
          </label>
          <div className="col field">
            <span className="eyebrow">Providers</span>
            <div className="row">
              {providers?.providers.map((p) => (
                <label key={p.id} className={`chip ${p.available ? (p.id === 'codex' ? 'ion' : p.id === 'local' ? 'leaf' : 'ember') : ''}`} title={p.reason ?? p.auth}>
                  <input type="checkbox" disabled={!p.available} checked={allowed.includes(p.id)} onChange={(e) => setAllowed((a) => (e.target.checked ? [...a, p.id] : a.filter((x) => x !== p.id)))} />
                  {p.label}
                  {!p.available && ' (unavailable)'}
                </label>
              ))}
            </div>
          </div>
          <label className="col field">
            <span className="eyebrow">Max delegation depth · {maxDepth}</span>
            <input type="range" min={1} max={4} value={maxDepth} onChange={(e) => setMaxDepth(+e.target.value)} />
          </label>
          <label className="col field">
            <span className="eyebrow">Max concurrent agents · {maxAgents}</span>
            <input type="range" min={1} max={12} value={maxAgents} onChange={(e) => setMaxAgents(+e.target.value)} />
          </label>
          <label className="col field">
            <span className="eyebrow">Token budget · {(maxTokens / 1e6).toFixed(1)}M</span>
            <input type="range" min={200000} max={20000000} step={100000} value={maxTokens} onChange={(e) => setMaxTokens(+e.target.value)} />
          </label>
          <label className="col field">
            <span className="eyebrow">Routing bias · {quality < 0.35 ? 'economy' : quality > 0.65 ? 'reliability' : 'balanced'}</span>
            <input type="range" min={0} max={1} step={0.05} value={quality} onChange={(e) => setQuality(+e.target.value)} />
          </label>
        </div>
        {err && <div className="note bad">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!objective.trim() || !allowed.length} onClick={start}>
            Launch ▸
          </button>
        </div>
      </div>
    </div>
  );
}
