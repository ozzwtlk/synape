import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api, bootstrap, type ProvidersResponse, type RunSummary } from './api';
import { openRun, useStore } from './store';
import { Graph } from './graph/Graph';
import { Inspector } from './panels/Inspector';
import { Chat } from './panels/Chat';
import { TopBar } from './panels/Hud';
import { Timeline } from './panels/Timeline';
import { NewRun, RunList } from './panels/Runs';
import { Fleet, GitPanel } from './panels/Fleet';
import { PaperView, RunSummaryModal } from './panels/Science';

export function App() {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [providers, setProviders] = useState<ProvidersResponse>();
  const [modal, setModal] = useState<'new' | 'fleet' | 'git' | 'summary' | 'paper' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const runId = useStore((s) => s.runId);
  const selection = useStore((s) => s.selection);
  const status = useStore((s) => s.live?.run.status);

  // Pop the summary once when a run you're watching finishes (not on replay, not again after closing).
  const cursor = useStore((s) => s.cursor);
  const prevStatus = useRef<{ runId: string | null; status?: string }>({ runId: null });
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = { runId, status };
    if (!runId || cursor !== null || prev.runId !== runId || !prev.status || prev.status === status) return;
    if ((status === 'completed' || status === 'failed') && ['running', 'planning'].includes(prev.status)) setModal('summary');
  }, [runId, status, cursor]);

  const refresh = useCallback(() => api.runs().then(setRuns), []);
  useEffect(() => {
    bootstrap()
      .then(async () => {
        setReady(true);
        const [r, p] = await Promise.all([api.runs(), api.providers()]);
        setRuns(r);
        setProviders(p);
        const fromHash = location.hash.slice(1);
        const initial = r.find((x) => x.id === fromHash) ?? r[0];
        if (initial) openRun(initial.id);
        else setModal('new');
      })
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    if (runId) history.replaceState(null, '', `#${runId}`);
    refresh();
  }, [runId, status, refresh]);
  useEffect(() => {
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  if (err) return <div className="boot">Cannot reach the Synape engine: {err}</div>;
  if (!ready) return <div className="boot">Connecting…</div>;
  return (
    <div className="app">
      <RunList runs={runs} onNew={() => setModal('new')} />
      <main className="stage">
        {runId ? (
          <ReactFlowProvider>
            <TopBar providers={providers} onGit={() => setModal('git')} onFleet={() => setModal('fleet')} onSummary={() => setModal('summary')} onPaper={() => setModal('paper')} />
            <div className="canvas">
              <Graph />
              {selection && <Inspector providers={providers} expanded={expanded} onExpand={() => setExpanded((x) => !x)} />}
            </div>
            <Timeline />
          </ReactFlowProvider>
        ) : (
          <div className="empty">
            <img src="/synape.svg" width={64} height={64} alt="" />
            <h1 className="display">Start a research mission</h1>
            <p className="faint">State a scientific objective. Synape plans it, delegates derivations, literature checks and computations to Claude and Codex agents, cross-checks every result with an independent model, and traces each figure in your manuscript back to the agent that produced it.</p>
            <button className="btn primary" onClick={() => setModal('new')}>
              + New mission
            </button>
          </div>
        )}
      </main>
      {runId && <Chat />}
      {modal === 'new' && <NewRun providers={providers} onClose={() => setModal(null)} />}
      {modal === 'fleet' && <Fleet providers={providers} onClose={() => setModal(null)} onRefresh={async () => (await api.refreshProviders(), setProviders(await api.providers()))} />}
      {modal === 'git' && <GitPanel onClose={() => setModal(null)} />}
      {modal === 'summary' && runId && <RunSummaryModal onClose={() => setModal(null)} onPaper={() => setModal('paper')} />}
      {modal === 'paper' && runId && <PaperView onClose={() => setModal(null)} />}
    </div>
  );
}
