import { useEffect, useRef, useState } from 'react';
import type { RunState } from '@synape/core';
import { api } from '../api';
import { select, useStore, viewState } from '../store';
import { familyOfProvider, fmtTime } from '../util';
import { Markdown } from './Markdown';

/** Orchestrator command center: conversation, approvals and agent Q&A. */
export function Chat() {
  const s = useStore(viewState);
  useStore((x) => x.version);
  const runId = useStore((x) => x.runId);
  const selection = useStore((x) => x.selection);
  const cursor = useStore((x) => x.cursor);
  const [text, setText] = useState('');
  const [askAgent, setAskAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const count = s?.messages.length ?? 0;
  const pending = s ? Object.values(s.approvals).filter((a) => a.status === 'pending') : [];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [count, pending.length]);

  if (!s || !runId) return null;
  const selAgentId = selection ? (selection.kind === 'agent' ? selection.id : s.tasks[selection.id]?.agentIds.filter((a) => s.agents[a]?.attempt).at(-1)) : undefined;
  const selAgent = selAgentId ? s.agents[selAgentId] : undefined;
  const target = askAgent && selAgent ? selAgent : undefined;

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.message(runId, text.trim(), target?.id);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat panel" aria-label="Orchestrator chat">
      <header className="row chat-head">
        <span className="nucleus-glyph" aria-hidden />
        <div className="grow">
          <div className="display" style={{ fontSize: 13.5, fontWeight: 600 }}>
            Command
          </div>
          <div className="faint" style={{ fontSize: 11 }}>
            {target ? `asking ${target.modelId} (resumed session, read-only)` : 'talking to the orchestrator'}
          </div>
        </div>
      </header>
      <div className="chat-log scroll">
        {s.messages.map((m) => (
          <Message key={m.id} s={s} m={m} />
        ))}
        {pending.map((a) => (
          <div key={a.id} className="approval card">
            <div className="row">
              <span className="chip warn">approval · {a.kind}</span>
              <span className="grow" />
              {a.taskId && (
                <button className="chip clickable" onClick={() => select({ kind: 'task', id: a.taskId! }, true)}>
                  {s.tasks[a.taskId]?.title}
                </button>
              )}
            </div>
            <p style={{ margin: '8px 0' }}>{a.description}</p>
            <div className="row">
              <button className="btn ok sm" disabled={cursor !== null} onClick={() => api.approve(runId, a.id, true)}>
                Approve
              </button>
              <button className="btn danger sm" disabled={cursor !== null} onClick={() => api.approve(runId, a.id, false)}>
                Deny
              </button>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        {selAgent && (
          <label className="row ask-toggle">
            <input type="checkbox" checked={askAgent} onChange={(e) => setAskAgent(e.target.checked)} />
            <span>
              Ask <b className={`fam-text-${familyOfProvider(selAgent.provider)}`}>{s.tasks[selAgent.taskId]?.title}</b> directly
            </span>
          </label>
        )}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <textarea
            className="textarea"
            rows={2}
            placeholder={cursor !== null ? 'Viewing history (return to live to send)' : target ? 'Question for this agent…' : 'Follow-up instruction, question, or change of plan…'}
            value={text}
            disabled={cursor !== null}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
            style={{ minHeight: 44 }}
          />
          <button className="btn primary" onClick={send} disabled={busy || !text.trim() || cursor !== null} title="Send (Ctrl+Enter)">
            Send
          </button>
        </div>
      </div>
    </section>
  );
}

function Message({ s, m }: { s: RunState; m: RunState['messages'][number] }) {
  const a = m.agentId ? s.agents[m.agentId] : undefined;
  const who = m.from === 'user' ? 'You' : m.from === 'orchestrator' ? 'Orchestrator' : m.from === 'agent' ? (a ? s.tasks[a.taskId]?.title ?? 'Agent' : 'Agent') : 'System';
  return (
    <div className={`msg from-${m.from}`}>
      <div className="row msg-meta">
        <span className={m.from === 'agent' && a ? `fam-text-${familyOfProvider(a.provider)}` : ''}>{who}</span>
        {m.from === 'user' && m.agentId && <span className="faint">→ {s.tasks[s.agents[m.agentId]?.taskId]?.title}</span>}
        <span className="grow" />
        <span className="faint mono">{fmtTime(m.ts)}</span>
      </div>
      <div className="msg-body">{m.from === 'user' ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.text}</p> : <Markdown text={m.text} />}</div>
      {m.refs && m.refs.length > 0 && (
        <div className="links" style={{ marginTop: 6 }}>
          {m.refs.slice(0, 12).map((r) =>
            s.tasks[r] ? (
              <button key={r} className="chip clickable" onClick={() => select({ kind: 'task', id: r }, true)}>
                ↗ {s.tasks[r].title}
              </button>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
