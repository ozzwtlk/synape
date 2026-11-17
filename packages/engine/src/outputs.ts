import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { OutputFile, RunState } from '@synape/core';

/** Directories never worth walking (caches, VCS, environments). */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ipynb_checkpoints', '.cache', '.tox', '.idea', '.vscode']);
/** Build by-products: modified in bulk by compilers, never what a scientist wants to see. */
const JUNK_EXT = /\.(o|a|so|dylib|pyc|pyo|mod|d|class|obj|lo|la|aux|fls|fdb_latexmk|synctex\.gz|toc|out|bbl|blg|nav|snm)$/i;

export const FIGURE_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i;
const PRIORITY = (rel: string) => (/\.pdf$/i.test(rel) ? 0 : FIGURE_EXT.test(rel) ? 1 : /\.(tex|md|bib|ipynb|py|wl|nb|m|jl|c|cpp|f90|f|csv|dat|json|txt|h5|hdf5|npz|npy)$/i.test(rel) ? 2 : 3);

interface Walk {
  maxDepth: number;
  maxVisit: number;
}

/** Breadth-first, so shallow files (the manuscript, figures/) win over huge vendored trees. */
function* walk(root: string, opt: Walk): Generator<string> {
  let visited = 0;
  let level = [root];
  for (let depth = 0; depth <= opt.maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++visited > opt.maxVisit) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) next.push(p);
        } else if (e.isFile()) yield p;
      }
    }
    level = next;
  }
}

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * In a git checkout, a fresh worktree gives every tracked file a new mtime.
 * Returns a filter keeping only files git says changed (since `sinceMs`) or
 * that git doesn't track (new outputs, ignored build products). null = not git.
 */
function gitFilter(root: string, sinceMs: number): ((abs: string) => boolean) | null {
  try {
    const top = git(root, ['rev-parse', '--show-toplevel']).trim();
    const abs = (rel: string) => resolve(top, rel);
    const tracked = new Set(git(root, ['ls-files', '-z', '--full-name']).split('\0').filter(Boolean).map(abs));
    const changed = new Set<string>();
    for (const e of git(root, ['status', '--porcelain', '-z', '--untracked-files=no']).split('\0')) if (e.length > 3) changed.add(abs(e.slice(3)));
    for (const l of git(root, ['log', `--since=@${Math.floor(sinceMs / 1000)}`, '--name-only', '--pretty=format:', 'HEAD']).split('\n')) if (l.trim()) changed.add(abs(l.trim()));
    return (p) => !tracked.has(p) || changed.has(p);
  } catch {
    return null;
  }
}

/** Files under `root` modified since `sinceMs`, most interesting first. */
export function modifiedSince(dir: string, sinceMs: number, limit = 200): OutputFile[] {
  const out: OutputFile[] = [];
  // Compare real paths with git's: a symlinked root would otherwise match nothing.
  let root = dir;
  try {
    root = realpathSync(dir);
  } catch {}
  const keep = gitFilter(root, sinceMs);
  for (const p of walk(root, { maxDepth: 7, maxVisit: 40_000 })) {
    const rel = relative(root, p);
    if (JUNK_EXT.test(rel) || basename(rel) === '.git') continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs >= sinceMs && (!keep || keep(p))) out.push({ path: p, rel, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  out.sort((a, b) => PRIORITY(a.rel) - PRIORITY(b.rel) || b.mtime - a.mtime);
  return out.slice(0, limit);
}

/** Copy figures/PDFs aside so later edits can't rewrite what this agent produced. */
export function snapshotFigures(files: OutputFile[], dir: string, maxBytes = 25 * 1024 * 1024) {
  for (const f of files) {
    if (!FIGURE_EXT.test(f.rel) || f.size > maxBytes) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, f.rel.replace(/[\\/]/g, '__'));
      copyFileSync(f.path, dest);
      f.snapshot = dest;
    } catch {}
  }
}

/** PDFs in a workspace (for the paper viewer). */
export function findPdfs(root: string, limit = 60): OutputFile[] {
  const out: OutputFile[] = [];
  for (const p of walk(root, { maxDepth: 4, maxVisit: 30_000 })) {
    if (!/\.pdf$/i.test(p)) continue;
    try {
      const st = statSync(p);
      out.push({ path: p, rel: relative(root, p), size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export interface TexInfo {
  /** Basenames (no extension) of graphics the manuscript includes. */
  names: string[];
  texFiles: string[];
  /** Root documents (contain \documentclass), shallowest first. */
  mains: string[];
  /** Each included graphic resolved to a file in the workspace, when found. */
  figures: { name: string; rel?: string; path?: string }[];
}

/** What the manuscript in a workspace includes, resolved to files. */
export function texGraphics(root: string): TexInfo {
  const names = new Set<string>();
  const texFiles: string[] = [];
  const mains: string[] = [];
  const graphics = new Map<string, OutputFile>();
  const sources = new Map<string, string>();
  for (const p of walk(root, { maxDepth: 4, maxVisit: 30_000 })) {
    const rel = relative(root, p);
    if (FIGURE_EXT.test(p)) {
      const k = basename(p).replace(/\.[^.]+$/, '');
      const prev = graphics.get(k);
      // Prefer the shallowest copy, and vector/PDF over raster.
      if (!prev || rel.split('/').length < prev.rel.split('/').length || (/\.pdf$/i.test(p) && !/\.pdf$/i.test(prev.rel))) graphics.set(k, { path: p, rel, size: 0, mtime: 0 });
      continue;
    }
    if (extname(p) !== '.tex') continue;
    texFiles.push(rel);
    let src = '';
    try {
      if (statSync(p).size > 4_000_000) continue;
      src = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const clean = src.replace(/(^|[^\\])%.*$/gm, '$1');
    sources.set(rel, clean);
    if (/^\s*\\documentclass/m.test(clean) && rel.split('/').length <= 2) mains.push(rel);
  }
  // Follow \input/\include from the root documents, so vendored manuals don't leak in.
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel) || !sources.has(rel)) return;
    seen.add(rel);
    const src = sources.get(rel)!;
    for (const m of src.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) names.add(basename(m[1].trim()).replace(/\.(png|jpe?g|pdf|eps|svg|gif)$/i, ''));
    for (const m of src.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
      const t = m[1].trim();
      visit(t.endsWith('.tex') ? t : `${t}.tex`);
    }
  };
  for (const r of mains.length ? mains : [...sources.keys()]) visit(r);
  mains.sort((a, b) => a.split('/').length - b.split('/').length || Number(!/main|paper|manuscript/i.test(a)) - Number(!/main|paper|manuscript/i.test(b)));
  const figures = [...names].map((name) => ({ name, rel: graphics.get(name)?.rel, path: graphics.get(name)?.path }));
  return { names: [...names], texFiles, mains, figures };
}

export const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/**
 * Older runs (before outputs were recorded): attribute files by timestamp to
 * the writing agent whose lifetime contains the file's mtime. Marked inferred.
 */
export function inferOutputs(s: RunState, worktreeBase: string): Record<string, OutputFile[]> {
  const out: Record<string, OutputFile[]> = {};
  const writers = Object.values(s.agents).filter((a) => a.attempt > 0 && a.endedAt && s.tasks[a.taskId] && !s.tasks[a.taskId].outputs?.length && !['plan', 'orchestrate', 'synthesize', 'review'].includes(s.tasks[a.taskId].kind));
  if (!writers.length) return out;
  const since = Math.min(...writers.map((a) => a.startedAt)) - 1000;
  const roots = new Set([s.run.workspace]);
  for (const a of writers) {
    const wt = join(worktreeBase, s.run.id, a.taskId);
    if (existsSync(wt)) roots.add(wt);
  }
  for (const root of roots) {
    for (const f of modifiedSince(root, since, 400)) {
      const own = root.startsWith(join(worktreeBase, s.run.id));
      const cands = writers.filter((a) => f.mtime >= a.startedAt - 1000 && f.mtime <= (a.endedAt ?? Date.now()) + 2000 && (!own || root.endsWith(a.taskId)));
      const a = cands.sort((x, y) => y.startedAt - x.startedAt)[0];
      if (!a) continue;
      (out[a.taskId] ??= []).push({ ...f, agentId: a.id });
    }
  }
  return out;
}
