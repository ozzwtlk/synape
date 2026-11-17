import { useEffect, useMemo, useRef, useState } from 'react';
import { loadEvents, setCursor, useStore } from '../store';
import { fmtTime } from '../util';

const NOTABLE = new Set(['task.created', 'agent.spawned', 'review.verdict', 'task.escalated', 'error', 'run.status', 'delegation.decided', 'approval.requested', 'recovery']);

/** Time-travel: scrub or play back the run, folded from the persisted event log. */
export function Timeline() {
  const live = useStore((x) => x.live);
  useStore((x) => x.version);
  const cursor = useStore((x) => x.cursor);
  const events = useStore((x) => x.events);
  const loaded = useStore((x) => x.eventsLoaded);
  const [playing, setPlaying] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const last = live?.lastSeq ?? 0;
  const pos = cursor ?? last;

  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, Math.round(last / 400));
    const t = setInterval(() => {
      const c = (useStoreCursor() ?? 0) + step;
      if (c >= last) {
        setPlaying(false);
        setCursor(null);
      } else setCursor(c);
    }, 40);
    return () => clearInterval(t);
  }, [playing, last]);

  // Density + notable marks from the full log (loaded lazily).
  const marks = useMemo(() => {
    if (!loaded || !events.length) return [];
    const out: { seq: number; type: string; tone: string }[] = [];
    for (const e of events) {
      const b = e.body as any;
      if (!NOTABLE.has(b.type)) continue;
      const tone = b.type === 'error' ? 'bad' : b.type === 'review.verdict' ? (b.verdict === 'pass' ? 'ok' : 'warn') : b.type === 'task.escalated' ? 'warn' : b.type === 'agent.spawned' ? (b.provider === 'codex' ? 'ion' : 'ember') : 'idle';
      out.push({ seq: e.seq, type: b.type, tone });
    }
    return out;
  }, [loaded, events]);

  if (!live) return null;
  const scrub = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const seq = Math.max(1, Math.round(f * last));
    setCursor(seq >= last ? null : seq);
  };
  const atEvent = cursor !== null ? events[cursor - 1] : undefined;
  return (
    <div className="timeline panel">
      <button
        className="btn sm icon-btn"
        aria-label={playing ? 'Pause replay' : 'Replay from start'}
        onClick={async () => {
          await loadEvents();
          if (!playing && cursor === null) await setCursor(1);
          setPlaying((p) => !p);
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div
        className="tl-track"
        ref={track}
        role="slider"
        aria-label="Event timeline"
        aria-valuemin={1}
        aria-valuemax={last}
        aria-valuenow={pos}
        tabIndex={0}
        onMouseEnter={() => loadEvents()}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setPlaying(false);
          scrub(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && scrub(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setCursor(Math.max(1, pos - (e.shiftKey ? 50 : 1)));
          if (e.key === 'ArrowRight') setCursor(pos + (e.shiftKey ? 50 : 1));
          if (e.key === 'End') setCursor(null);
        }}
      >
        {marks.map((m) => (
          <i key={m.seq} className={`tl-mark t-${m.tone}`} style={{ left: `${(m.seq / last) * 100}%` }} />
        ))}
        <div className="tl-fill" style={{ width: `${(pos / Math.max(1, last)) * 100}%` }} />
        <div className="tl-head" style={{ left: `${(pos / Math.max(1, last)) * 100}%` }} />
      </div>
      <div className="mono tl-label">
        {cursor === null ? (
          <span className="row" style={{ gap: 6 }}>
            <span className="dot live" style={{ color: 'var(--ok)' }} /> LIVE · {last}
          </span>
        ) : (
          <span>
            {cursor}/{last}
            {atEvent ? ` · ${fmtTime(atEvent.ts)} · ${(atEvent.body as any).type}` : ''}
          </span>
        )}
      </div>
      {cursor !== null && (
        <button className="btn sm" onClick={() => (setPlaying(false), setCursor(null))}>
          Live ⇥
        </button>
      )}
    </div>
  );
}

import { getStore } from '../store';
const useStoreCursor = () => getStore().cursor;
