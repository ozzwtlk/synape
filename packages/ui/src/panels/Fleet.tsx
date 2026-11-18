import { useEffect, useState } from 'react';
import { api, type ProvidersResponse, type RepoInfo } from '../api';
import { useStore, viewState } from '../store';
import { fmtDuration, fmtTokens } from '../util';

export function Fleet({ providers, onClose, onRefresh }: { providers?: ProvidersResponse; onClose: () => void; onRefresh: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel" style={{ width: 780 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Fleet">
        <div className="row">
          <h2 className="display" style={{ margin: 0, fontSize: 20 }}>
            Fleet
          </h2>
          <span className="grow" />
          <button className="btn sm" onClick={onRefresh}>
            Re-detect
          </button>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="col" style={{ marginTop: 12 }}>
          {providers?.providers.map((p) => (
            <div key={p.id} className="card row">
              <span className={`dot`} style={{ color: p.available ? 'var(--ok)' : 'var(--bad)' }} />
              <b>{p.label}</b>
              <span className="mono faint">{p.version}</span>
              <span className="grow" />
              <span className="mono faint">{p.available ? p.auth : p.reason}</span>
              <span className="chip">{p.billing}</span>
              {p.billing !== 'local' && <WeightInput provider={p.id} value={providers.models.find((m) => m.provider === p.id)?.quotaWeight ?? 1} onSaved={onRefresh} />}
            </div>
          ))}
        </div>
        <div className="eyebrow" style={{ margin: '16px 0 6px' }}>
          Model catalog (cold-start priors; refined by local history). Untick models your plan doesn't include. RU/1k includes the provider's quota weight (×, above).
        </div>
        <table className="cand">
          <thead>
            <tr>
              <th title="Allow the router to use this model">on</th>
              <th>model</th>
              <th>tier</th>
              <th>RU/1k</th>
              <th>context</th>
              <th>coding</th>
              <th>reasoning</th>
              <th>extraction</th>
              <th>review</th>
            </tr>
          </thead>
          <tbody>
            {providers?.models.map((m) => (
              <tr key={m.id} className={m.available ? '' : 'rej'} title={m.unavailableReason}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Enable ${m.label}`}
                    checked={!m.disabled}
                    onChange={async (e) => {
                      await api.setModelEnabled(m.id, e.target.checked);
                      onRefresh();
                    }}
                  />
                </td>
                <td className={`fam-text-${m.provider === 'codex' ? 'openai' : m.provider === 'local' ? 'local' : 'anthropic'}`}>{m.label}</td>
                <td className="mono">{m.tier}</td>
                <td className="mono">{m.ruPer1kTokens}</td>
                <td className="mono">{fmtTokens(m.contextWindow)}</td>
                {(['coding', 'reasoning', 'extraction', 'review'] as const).map((c) => (
                  <td key={c} className="mono">
                    {m.skill[c]?.toFixed(2) ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="eyebrow" style={{ margin: '16px 0 6px' }}>
          Observed performance (local history)
        </div>
        {providers?.perf.length ? (
          <table className="cand">
            <thead>
              <tr>
                <th>model</th>
                <th>category</th>
                <th>runs</th>
                <th>success</th>
                <th>mean tokens</th>
                <th>mean time</th>
              </tr>
            </thead>
            <tbody>
              {providers.perf.map((r) => (
                <tr key={r.modelId + r.category}>
                  <td>{r.modelId}</td>
                  <td>{r.category}</td>
                  <td className="mono">{r.n}</td>
                  <td className="mono">{Math.round((r.successes / r.n) * 100)}%</td>
                  <td className="mono">{fmtTokens(r.meanTokens)}</td>
                  <td className="mono">{fmtDuration(r.meanDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="faint">No history yet.</p>
        )}
        <p className="faint" style={{ fontSize: 11 }}>
          Success = accepted by independent review (or completed when no review was required). Provider errors (auth, rate limits) are not counted against a model.
        </p>
      </div>
    </div>
  );
}

/** Quota weight: how much one token from this provider "costs" relative to the catalog. */
function WeightInput({ provider, value, onSaved }: { provider: string; value: number; onSaved: () => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const save = async () => {
    const n = Number(v);
    if (!(n >= 0.1 && n <= 20) || n === value) return setV(String(value));
    await api.setProviderWeight(provider, n);
    onSaved();
  };
  return (
    <label className="row mono faint" style={{ gap: 4 }} title="Quota weight: multiplies this provider's RU per 1k tokens. Higher = the router avoids it unless it is really needed.">
      ×
      <input className="mono" style={{ width: 44 }} value={v} inputMode="decimal" aria-label={`Quota weight for ${provider}`} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

export function GitPanel({ onClose }: { onClose: () => void }) {
  const s = useStore(viewState);
  const runId = useStore((x) => x.runId);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (s) api.git(s.run.workspace).then(setInfo);
  }, [s?.run.workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s || !runId) return null;
  const merges = s.messages.filter((m) => m.from === 'system' && /Merged|merge|push|pull/i.test(m.text));
  const req = async (kind: string) => {
    setBusy(kind);
    try {
      await api.gitAction(runId, kind);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel" style={{ width: 620 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Git">
        <div className="row">
          <h2 className="display" style={{ margin: 0, fontSize: 20 }}>
            Git &amp; publication
          </h2>
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        {!info ? (
          <p className="faint">Inspecting…</p>
        ) : !info.isRepo ? (
          <p className="faint">The workspace is not a git repository. Agents edit files in place, one writer at a time.</p>
        ) : (
          <>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>repository</dt>
              <dd className="mono">{info.root}</dd>
              <dt>your branch</dt>
              <dd className="mono">
                {info.branch} @ {info.head} {info.dirty ? <span className="chip warn">{info.dirty} modified</span> : <span className="chip ok">clean</span>}
              </dd>
              <dt>run branch</dt>
              <dd className="mono">synape/{runId.slice(0, 8)} (verified work is merged here, locally)</dd>
              <dt>identity</dt>
              <dd>{info.userName ?? 'not configured'}</dd>
              <dt>remotes</dt>
              <dd className="mono">{info.remotes?.map((r) => `${r.name} ${r.url}`).join(', ') || 'none'}</dd>
              <dt>GitHub CLI</dt>
              <dd>{info.ghAuthenticated ? <span className="chip ok">authenticated</span> : <span className="chip">not authenticated</span>}</dd>
            </dl>
            <div className="note" style={{ marginTop: 12 }}>
              Every action below creates an approval request in the command chat, and nothing runs until you approve it there. Credentials are never read by Synape: git and gh use your configured helpers.
            </div>
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn" disabled={!!busy} onClick={() => req('git-commit')}>
                Merge run branch into {info.branch}
              </button>
              <button className="btn" disabled={!!busy || !info.remotes?.length} onClick={() => req('git-push')}>
                Push run branch
              </button>
              <button className="btn" disabled={!!busy || !info.ghAuthenticated} onClick={() => req('pull-request')}>
                Open pull request
              </button>
            </div>
          </>
        )}
        {merges.length > 0 && (
          <>
            <div className="eyebrow" style={{ margin: '16px 0 6px' }}>
              Audit trail
            </div>
            <div className="terminal" style={{ maxHeight: 200 }}>
              {merges.map((m) => (
                <div key={m.id}>{m.text}</div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
