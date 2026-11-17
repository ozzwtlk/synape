import { useEffect, useMemo, useState } from 'react';
import type { OutputFile, RunState, Task } from '@synape/core';
import { billableTokens } from '@synape/core';
import { api, fileUrl, type OutputsResponse } from '../api';
import { select, useStore, viewState } from '../store';
import { KIND_LABEL, fmtDuration, fmtTokens, latestAgent } from '../util';
import { Markdown } from './Markdown';

const FIG = /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i;
const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
const TEXT = /\.(md|tex|bib|txt|py|wl|m|jl|c|cc|cpp|h|f|f90|csv|dat|json|ya?ml|toml|sh|log|out|par)$/i;
const base = (p: string) => p.split('/').pop() ?? p;
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '');

export interface ProducedFile extends OutputFile {
  taskId: string;
  inferred: boolean;
}

/** Everything the run produced, refreshed while it runs. */
export function useOutputs(runId: string | null, live: boolean) {
  const [data, setData] = useState<OutputsResponse | null>(null);
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const load = () => api.outputs(runId).then((d) => !stop && setData(d)).catch(() => {});
    load();
    const t = live ? setInterval(load, 20_000) : undefined;
    return () => {
      stop = true;
      if (t) clearInterval(t);
    };
  }, [runId, live]);
  const files = useMemo(() => {
    if (!data) return [] as ProducedFile[];
    const out: ProducedFile[] = [];
    for (const [taskId, fs] of Object.entries(data.recorded)) for (const f of fs) out.push({ ...f, taskId, inferred: false });
    for (const [taskId, fs] of Object.entries(data.inferred)) for (const f of fs) out.push({ ...f, taskId, inferred: true });
    return out;
  }, [data]);
  return { data, files };
}

const inPaper = (f: { rel: string }, tex?: OutputsResponse['tex']) => !!tex?.names.includes(stem(f.rel));

/** One tile per plot: `x.pdf` + `x.png` side by side become one entry (raster preview, both formats listed). */
function dedupeFigures(fs: ProducedFile[]): (ProducedFile & { formats: string[] })[] {
  const by = new Map<string, ProducedFile[]>();
  for (const f of fs) {
    const k = `${f.taskId}:${f.rel.replace(/\.[^.]+$/, '')}`;
    by.set(k, [...(by.get(k) ?? []), f]);
  }
  return [...by.values()].map((g) => {
    const pick = g.find((x) => IMG.test(x.rel)) ?? g[0];
    return { ...pick, formats: g.length > 1 ? g.map((x) => x.rel.split('.').pop()!.toLowerCase()) : [] };
  });
}

const InferredNote = ({ files }: { files: ProducedFile[] }) =>
  files.some((f) => f.inferred) ? <p className="faint" style={{ fontSize: 11, margin: '0 0 8px' }}>This run started before output tracking: files are attributed to nodes by their timestamps and git status.</p> : null;

/** A figure tile: image or first page of a PDF, with provenance. */
function Figure({ runId, f, tex, onOpen, showTask, s }: { runId: string; f: ProducedFile; tex?: OutputsResponse['tex']; onOpen: (f: ProducedFile) => void; showTask?: boolean; s?: RunState }) {
  const src = f.snapshot ?? f.path;
  const t = s?.tasks[f.taskId];
  const a = t ? latestAgent(s!, t) : undefined;
  return (
    <figure className="fig" onClick={() => onOpen(f)} title={f.rel}>
      <div className="fig-img">{IMG.test(f.rel) || /\.pdf$/i.test(f.rel) ? <img loading="lazy" src={fileUrl(runId, src, /\.pdf$/i.test(f.rel))} alt={base(f.rel)} /> : <span className="faint mono">{f.rel.split('.').pop()}</span>}</div>
      <figcaption>
        <span className="ellipsis mono">{base(f.rel)}</span>
        <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {inPaper(f, tex) && <span className="chip ok xs">in paper</span>}
          {(f as ProducedFile & { formats?: string[] }).formats?.map((x) => (
            <span key={x} className="chip xs">
              {x}
            </span>
          ))}
          {showTask && t && (
            <button
              className="chip clickable xs"
              onClick={(e) => {
                e.stopPropagation();
                select({ kind: 'task', id: t.id }, true);
              }}
              title={`Produced by: ${t.title}`}
            >
              ↖ {t.title.slice(0, 26)}
              {a ? ` · ${a.modelId.split(':')[1]}` : ''}
            </button>
          )}
        </span>
      </figcaption>
    </figure>
  );
}

/** Inline viewer for a produced file: native PDF viewer, images, text/markdown. */
export function FileViewer({ runId, f, height = '70vh' }: { runId: string; f: OutputFile; height?: string }) {
  const src = f.snapshot ?? f.path;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!TEXT.test(f.rel) || f.size > 600_000) return;
    fetch(fileUrl(runId, src))
      .then((r) => r.text())
      .then(setText)
      .catch((e) => setText(`(could not load: ${e})`));
  }, [runId, src, f.rel, f.size]);
  return (
    <div className="viewer">
      <div className="row viewer-head">
        <span className="mono ellipsis grow" title={f.path}>
          {f.rel}
        </span>
        <span className="mono faint">{fmtTokens(f.size)}B</span>
        <a className="btn sm ghost" href={fileUrl(runId, src)} target="_blank" rel="noreferrer">
          Open ↗
        </a>
      </div>
      {/\.pdf$/i.test(f.rel) ? (
        navigator.pdfViewerEnabled === false ? (
          <PdfPages runId={runId} path={src} height={height} />
        ) : (
          <iframe className="pdf" title={f.rel} src={`${fileUrl(runId, src)}#view=FitH`} style={{ height }} />
        )
      ) : IMG.test(f.rel) ? (
        <img className="viewer-img" src={fileUrl(runId, src)} alt={f.rel} />
      ) : text !== null ? (
        /\.md$/i.test(f.rel) ? <Markdown text={text} /> : <pre className="terminal" style={{ maxHeight: height }}>{text}</pre>
      ) : (
        <p className="faint">{TEXT.test(f.rel) ? 'Loading…' : 'No inline preview for this file type; use Open ↗.'}</p>
      )}
    </div>
  );
}

/** Fallback for browsers without a PDF viewer: pages rendered server-side (poppler), loaded lazily. */
function PdfPages({ runId, path, height }: { runId: string; path: string; height: string }) {
  const [pages, setPages] = useState(3);
  const [end, setEnd] = useState<number | null>(null);
  return (
    <div className="pdf-pages scroll" style={{ height }}>
      {Array.from({ length: end ?? pages }, (_, i) => (
        <img
          key={i}
          loading="lazy"
          src={`${fileUrl(runId, path)}&page=${i + 1}`}
          alt={`page ${i + 1}`}
          onLoad={() => i + 1 === pages && end === null && setPages((p) => Math.min(p + 3, 300))}
          onError={() => setEnd((e) => (e === null || i < e ? i : e))}
        />
      ))}
    </div>
  );
}

/** Inspector tab: what this node wrote or produced. */
export function OutputsTab({ runId, s, t }: { runId: string; s: RunState; t: Task }) {
  const live = s.run.status === 'running';
  const { data, files } = useOutputs(runId, live);
  // Orchestrators show everything their subtree produced.
  const scope = new Set([t.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of Object.values(s.tasks)) if (x.parentTaskId && scope.has(x.parentTaskId) && !scope.has(x.id)) (scope.add(x.id), (grew = true));
  }
  const mine = files.filter((f) => scope.has(f.taskId));
  const [open, setOpen] = useState<ProducedFile | null>(null);
  if (!data) return <p className="faint">Scanning outputs…</p>;
  if (!mine.length) return <p className="faint">{t.permission === 'read' ? 'Read-only task: it reports findings but writes no files.' : 'No files produced (yet).'}</p>;
  const figs = dedupeFigures(mine.filter((f) => FIG.test(f.rel)));
  const other = mine.filter((f) => !FIG.test(f.rel));
  return (
    <div className="col" style={{ gap: 12 }}>
      <InferredNote files={mine} />
      {open && <FileViewer runId={runId} f={open} height="56vh" />}
      {figs.length > 0 && (
        <section>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Figures &amp; PDFs · {figs.length}
          </div>
          <div className="fig-grid">
            {figs.map((f) => (
              <Figure key={f.path} runId={runId} f={f} tex={data.tex} onOpen={setOpen} />
            ))}
          </div>
        </section>
      )}
      {other.length > 0 && (
        <section>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Files written · {other.length}
          </div>
          <div className="file-list">
            {other.map((f) => (
              <button key={f.path} className="file-row" onClick={() => setOpen(f)} title={f.path}>
                <span className="mono ellipsis grow">{f.rel}</span>
                <span className="mono faint">{fmtTokens(f.size)}B</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Paper view: the manuscript PDF beside every figure, each traced to the node that made it. */
export function PaperView({ onClose }: { onClose: () => void }) {
  const s = useStore(viewState);
  const runId = useStore((x) => x.runId);
  const { data, files } = useOutputs(runId, s?.run.status === 'running');
  const [pdf, setPdf] = useState<OutputFile | null>(null);
  const [onlyPaper, setOnlyPaper] = useState(false);
  const [zoom, setZoom] = useState<ProducedFile | null>(null);
  const mainStems = useMemo(() => new Set((data?.tex.mains ?? []).map(stem)), [data]);
  const pdfs = useMemo(() => {
    // Same relative path in several worktrees: keep the newest copy.
    const byRel = new Map<string, OutputFile>();
    for (const f of [...(data?.pdfs ?? []), ...files.filter((f) => /\.pdf$/i.test(f.rel))]) {
      const prev = byRel.get(f.rel);
      if (!prev || f.mtime > prev.mtime) byRel.set(f.rel, f);
    }
    // The compiled manuscript first, then figures/plots, then everything else.
    const rank = (f: OutputFile) => (mainStems.has(stem(f.rel)) && f.rel.split('/').length <= 2 ? 0 : /(^|\/)(figures?|plots?|output)\//i.test(f.rel) ? 1 : 2);
    return [...byRel.values()].sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
  }, [data, files, mainStems]);
  const manuscript = pdfs.find((f) => mainStems.has(stem(f.rel)) && f.rel.split('/').length <= 2);
  useEffect(() => {
    if (!pdf && pdfs.length) setPdf(pdfs[0]);
  }, [pdfs, pdf]);
  if (!s || !runId) return null;
  const figs = dedupeFigures(files.filter((f) => FIG.test(f.rel) && (!onlyPaper || inPaper(f, data?.tex))));
  const used = new Set(files.filter((f) => FIG.test(f.rel) && inPaper(f, data?.tex)).map((f) => stem(f.rel))).size;
  const producerOf = (name: string) => files.find((f) => FIG.test(f.rel) && stem(f.rel) === name);
  const byTask = new Map<string, ProducedFile[]>();
  for (const f of figs) byTask.set(f.taskId, [...(byTask.get(f.taskId) ?? []), f]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel paper" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Paper and figures">
        <div className="row">
          <h2 className="display" style={{ margin: 0, fontSize: 20 }}>
            Paper &amp; figures
          </h2>
          <span className="faint mono" style={{ fontSize: 11 }}>
            {data?.tex.mains[0] ? `${data.tex.mains[0]} · ` : ''}
            {dedupeFigures(files.filter((f) => FIG.test(f.rel))).length} figures produced by agents{data?.tex.names.length ? ` · ${used} of ${data.tex.names.length} manuscript figures` : ''}
          </span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {!data ? (
          <p className="faint">Scanning the workspace…</p>
        ) : (
          <div className="paper-grid">
            <section className="paper-doc">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {pdfs.slice(0, 12).map((p) => (
                  <button key={p.path} className={`chip clickable ${p.path === pdf?.path ? 'nucleus' : ''}`} onClick={() => setPdf(p)} title={p.path}>
                    {p.rel}
                  </button>
                ))}
              </div>
              {!manuscript && data.tex.mains[0] && (
                <div className="note">
                  <b>{data.tex.mains[0]}</b> has no compiled PDF yet. Ask the orchestrator to compile it (e.g. “compile the manuscript with latexmk”) and it will appear here first.
                </div>
              )}
              {pdf ? <FileViewer runId={runId} f={pdf} height="calc(100vh - 250px)" /> : <p className="faint">No PDF in the workspace yet.</p>}
            </section>
            <section className="paper-figs scroll">
              <div className="row" style={{ marginBottom: 8 }}>
                <div className="eyebrow grow">Provenance: who produced each figure</div>
                {data.tex.names.length > 0 && (
                  <label className="row faint" style={{ gap: 4, fontSize: 11 }}>
                    <input type="checkbox" checked={onlyPaper} onChange={(e) => setOnlyPaper(e.target.checked)} /> only in paper
                  </label>
                )}
              </div>
              {zoom && (
                <div style={{ marginBottom: 10 }}>
                  <FileViewer runId={runId} f={zoom} height="40vh" />
                </div>
              )}
              {data.tex.figures.length > 0 && (
                <div className="prov">
                  <div className="prov-head" style={{ cursor: 'default' }}>
                    <span className="eyebrow">MANUSCRIPT</span>
                    <b>Figures in {data.tex.mains[0] ?? 'the .tex sources'}</b>
                  </div>
                  <div className="fig-grid">
                    {data.tex.figures.map((g) => {
                      const made = producerOf(g.name);
                      const t = made ? s.tasks[made.taskId] : undefined;
                      return (
                        <figure key={g.name} className="fig" onClick={() => g.path && setZoom({ path: g.path, rel: g.rel!, size: 0, mtime: 0, taskId: '', inferred: false })} title={g.rel ?? `${g.name}: not found in the workspace`}>
                          <div className="fig-img">{g.path ? <img loading="lazy" src={fileUrl(runId, g.path, /\.pdf$/i.test(g.path))} alt={g.name} /> : <span className="faint mono">missing</span>}</div>
                          <figcaption>
                            <span className="ellipsis mono">{g.name}</span>
                            {t ? (
                              <button
                                className="chip clickable xs ok"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  select({ kind: 'task', id: t.id }, true);
                                  onClose();
                                }}
                              >
                                ↖ {t.title.slice(0, 24)}
                              </button>
                            ) : (
                              <span className="chip xs">{g.path ? 'pre-existing' : 'missing file'}</span>
                            )}
                          </figcaption>
                        </figure>
                      );
                    })}
                  </div>
                </div>
              )}
              <InferredNote files={files} />
              {[...byTask].map(([taskId, fs]) => {
                const t = s.tasks[taskId];
                const a = t ? latestAgent(s, t) : undefined;
                return (
                  <div key={taskId} className="prov">
                    <button
                      className="prov-head"
                      onClick={() => {
                        select({ kind: 'task', id: taskId }, true);
                        onClose();
                      }}
                      title="Show this node in the graph"
                    >
                      <span className="eyebrow">{t ? KIND_LABEL[t.kind] : 'TASK'}</span>
                      <b className="ellipsis">{t?.title ?? taskId}</b>
                      <span className="mono faint">{a?.modelId.replace('claude-code:', 'claude ').replace('codex:', '')}</span>
                      {t?.verified && <span className="chip ok xs">verified</span>}
                    </button>
                    <div className="fig-grid">
                      {fs.map((f) => (
                        <Figure key={f.path} runId={runId} f={f} tex={data.tex} onOpen={setZoom} />
                      ))}
                    </div>
                  </div>
                );
              })}
              {!figs.length && <p className="faint">No figures produced{onlyPaper ? ' that the manuscript includes' : ''} yet.</p>}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/** First sentences of a summary as a fallback TL;DR. */
const firstSentences = (text: string, n = 3) =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .slice(0, n)
    .join(' ');

/** End-of-run summary: answer first, then what's verified, what failed, and where the deliverables are. */
export function RunSummaryModal({ onClose, onPaper }: { onClose: () => void; onPaper: () => void }) {
  const s = useStore(viewState);
  const runId = useStore((x) => x.runId);
  const { data, files } = useOutputs(runId, false);
  const [report, setReport] = useState<string | null>(null);
  if (!s || !runId) return null;
  const root = s.run.rootTaskId ? s.tasks[s.run.rootTaskId] : undefined;
  const tasks = Object.values(s.tasks);
  const work = tasks.filter((t) => t.kind === 'work');
  const verified = work.filter((t) => t.verified).length;
  const failed = tasks.filter((t) => t.status === 'failed' && t.kind !== 'review');
  const synth = tasks.filter((t) => t.kind === 'synthesize' && t.parentTaskId === root?.id && t.status === 'completed').at(-1);
  const tldr = root?.resultTldr ?? synth?.resultTldr;
  // Before the final synthesis, the root's own summary is just the planner restating the task.
  const summary = root?.status === 'completed' ? root.resultSummary : synth?.resultSummary;
  const lastNote = [...s.messages].reverse().find((m) => m.from === 'orchestrator' && m.text.length > 80);
  const finalArt = s.run.finalArtifactId ? s.artifacts[s.run.finalArtifactId] : synth ? s.artifacts[synth.artifactIds.at(-1) ?? ''] : undefined;
  const figures = files.filter((f) => FIG.test(f.rel) && !/\.pdf$/i.test(f.rel)).length + files.filter((f) => /\.pdf$/i.test(f.rel)).length;
  const elapsed = (s.run.endedAt ?? Date.now()) - s.run.createdAt;
  const cost = Object.values(s.usageByProvider).reduce((a, u) => a + (u.costUsd ?? 0), 0);
  const top = tasks.filter((t) => t.parentTaskId === root?.id && t.kind !== 'review' && t.kind !== 'synthesize');
  const st = s.run.status;
  const headline = st === 'completed' ? 'Run complete' : st === 'failed' ? 'Run stopped: some work failed' : st === 'paused' ? 'Run paused' : st === 'cancelled' ? 'Run cancelled' : 'Run in progress';
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal panel summary" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Run summary">
        <div className="row">
          <span className={`run-status rs-${st}`}>
            <span className={`dot ${st === 'running' ? 'live' : ''}`} />
            {st}
          </span>
          <h2 className="display" style={{ margin: 0, fontSize: 21 }}>
            {headline}
          </h2>
          <span className="grow" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sum-stats">
          <Stat k="tasks" v={`${tasks.filter((t) => t.status === 'completed').length}/${tasks.length}`} />
          <Stat k="verified" v={`${verified}/${work.length}`} tone={verified === work.length && work.length ? 'ok' : 'warn'} />
          <Stat k="failed" v={String(failed.length)} tone={failed.length ? 'bad' : undefined} />
          <Stat k="figures + PDFs" v={data ? String(figures) : '…'} />
          <Stat k="time" v={fmtDuration(elapsed)} />
          <Stat k="tokens" v={fmtTokens(billableTokens(s.totals))} />
          <Stat k="API-equivalent" v={cost ? `$${cost.toFixed(2)}` : 'n/a'} />
        </div>
        <section className="sum-tldr">
          <div className="eyebrow">TL;DR</div>
          {tldr ? (
            <Markdown text={tldr} />
          ) : summary ? (
            <p>{firstSentences(summary)}</p>
          ) : (
            <>
              <p className="faint" style={{ margin: '0 0 6px' }}>
                No final synthesis yet: the run is {st}. {lastNote ? 'Latest status from the orchestrator:' : ''}
              </p>
              {lastNote && <Markdown text={lastNote.text.length > 900 ? `${lastNote.text.slice(0, 900)}…` : lastNote.text} />}
            </>
          )}
        </section>
        {failed.length > 0 && (
          <section>
            <div className="eyebrow" style={{ color: 'var(--bad)' }}>
              Needs attention
            </div>
            {failed.map((t) => (
              <button key={t.id} className="sum-row" onClick={() => (select({ kind: 'task', id: t.id }, true), onClose())}>
                <span className="dot" style={{ color: 'var(--bad)' }} />
                <b>{t.title}</b>
                <span className="faint ellipsis">{t.statusReason}</span>
              </button>
            ))}
            {(st === 'failed' || st === 'paused') && (
              <button className="btn sm ok" style={{ marginTop: 6 }} onClick={() => api.control(runId, 'resume')}>
                Resume (reopens failed tasks)
              </button>
            )}
          </section>
        )}
        {top.length > 0 && (
          <section>
            <div className="eyebrow">Results by workstream</div>
            {top.map((t) => (
              <button key={t.id} className="sum-row" onClick={() => (select({ kind: 'task', id: t.id }, true), onClose())}>
                <span className="dot" style={{ color: t.status === 'completed' ? (t.verified ? 'var(--ok)' : 'var(--warn)') : t.status === 'failed' ? 'var(--bad)' : 'var(--idle)' }} />
                <b className="ellipsis" style={{ maxWidth: 260 }}>
                  {t.title}
                </b>
                <span className="faint ellipsis grow">{t.resultSummary ? firstSentences(t.resultSummary, 1) : t.statusReason ?? t.status}</span>
                {t.verified && <span className="chip ok xs">verified</span>}
              </button>
            ))}
          </section>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {finalArt && (
            <button className="btn sm primary" onClick={() => (report === null ? api.artifact(runId, finalArt.id).then(setReport) : setReport(null))}>
              {report === null ? 'Read the full report' : 'Hide report'}
            </button>
          )}
          <button className="btn sm" onClick={onPaper}>
            ◫ Paper &amp; figures
          </button>
          {finalArt && <span className="mono faint ellipsis" style={{ fontSize: 10.5 }}>{finalArt.path}</span>}
        </div>
        {report !== null && (
          <div className="sum-report scroll">
            <Markdown text={report} />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className={`sum-stat ${tone ? `s-${tone}` : ''}`}>
      <b>{v}</b>
      <span>{k}</span>
    </div>
  );
}
