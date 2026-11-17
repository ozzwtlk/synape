/**
 * Recognise "computations" in agent tool calls: running Python, Wolfram,
 * MadGraph, micrOMEGAs, a compiled binary… as opposed to reading files or
 * grepping. Pure and deterministic so the reducer (and replay) can use it.
 */

const KNOWN: [RegExp, string][] = [
  [/^(python[\d.]*|ipython3?|pypy3?|pytest|jupyter|papermill)$/i, 'Python'],
  [/^(wolframscript|wolfram|math|mathkernel|wolframkernel)$/i, 'Wolfram'],
  [/^(mathematica)$/i, 'Mathematica'],
  [/^(mg5_amc|mg5|madevent|generate_events|madgraph)$/i, 'MadGraph'],
  [/^(micromegas)$/i, 'micrOMEGAs'],
  [/^(julia)$/, 'Julia'],
  [/^(R|Rscript)$/, 'R'],
  [/^(octave|octave-cli)$/, 'Octave'],
  [/^(matlab)$/i, 'MATLAB'],
  [/^(sage)$/, 'Sage'],
  [/^(maxima)$/, 'Maxima'],
  [/^(form|tform)$/, 'FORM'],
  [/^(root|root\.exe)$/, 'ROOT'],
  [/^(pythia8?\S*)$/i, 'Pythia'],
  [/^(delphes\S*)$/i, 'Delphes'],
  [/^(gnuplot)$/, 'gnuplot'],
  [/^(lean|lake)$/, 'Lean'],
  [/^(node|deno|bun)$/, 'Node'],
  [/^(latexmk|pdflatex|lualatex|xelatex|tectonic)$/, 'LaTeX'],
  [/^(gcc|g\+\+|clang|clang\+\+|cc|c\+\+|gfortran|make|cmake|ninja|cargo|rustc)$/, 'Build'],
];

/** Commands that only prefix another command. */
const WRAPPERS = new Set(['sudo', 'time', 'nice', 'nohup', 'env', 'exec', 'command', 'stdbuf', 'xvfb-run', 'taskset', 'ionice']);
const RUNNERS: Record<string, number> = { uv: 1, poetry: 1, pixi: 1, pdm: 1, hatch: 1 }; // `<x> run …`

/** Scientific packages recognised by path, even when invoked as ./main or via make. */
const BY_PATH: [RegExp, string][] = [
  [/micromegas/i, 'micrOMEGAs'],
  [/madgraph|mg5_?amc/i, 'MadGraph'],
  [/pythia/i, 'Pythia'],
  [/delphes/i, 'Delphes'],
];

/** Path-invoked things that are not computations (coreutils, data files). */
const NOT_PROGRAMS = /^(cat|ls|grep|rg|sed|awk|head|tail|find|rm|cp|mv|mkdir|echo|which|env|git|tar|chmod)$|\.(tex|md|txt|json|dat|csv|bib|log|pdf|png|svg|wl|nb|f|f90|c|cc|cpp|h|hpp|toml|ya?ml)$/i;

const unquote = (s: string) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');

function shellCommand(name: string, input: string): string | undefined {
  if (/^(bash|shell|exec_command|local_shell|run_command)$/i.test(name)) {
    const m = input.match(/"(?:command|cmd)"\s*:\s*("(?:[^"\\]|\\.)*)/);
    if (m) {
      try {
        return JSON.parse(m[1].endsWith('"') ? m[1] : `${m[1]}"`);
      } catch {
        return m[1].slice(1);
      }
    }
    return input.trim().startsWith('{') ? undefined : input;
  }
  return undefined;
}

function classifyCommand(cmd: string, depth = 0): string | undefined {
  let best: { program: string; rank: number } | undefined;
  const consider = (program: string, rank: number) => {
    if (!best || rank > best.rank) best = { program, rank };
  };
  for (const raw of cmd.split(/&&|\|\||;|\||\n/)) {
    const toks = raw.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (/^\w+=/.test(t) || WRAPPERS.has(t)) i++;
      else if (t === 'timeout') i += 2;
      else if (RUNNERS[t] && toks[i + 1] === 'run') i += 2;
      else if (t === 'conda' && toks[i + 1] === 'run') {
        i += 2;
        while (toks[i]?.startsWith('-')) i += toks[i] === '-n' || toks[i] === '-p' ? 2 : 1;
      } else break;
    }
    const exe = toks[i] ? unquote(toks[i]) : undefined;
    if (!exe) continue;
    // `bash -lc '…'` (how Codex wraps commands): classify the inner script.
    const base = exe.split('/').pop()!;
    if (/^(ba|z|da)?sh$/.test(base)) {
      const script = toks[i + 1] ? unquote(toks[i + 1]) : '';
      // `bash build.sh`: running a script is a computation named after it.
      if (/\.(sh|bash|zsh)$/.test(script)) consider(script.split('/').pop()!, 2);
      if (!/^-\w*c$/.test(toks[i + 1] ?? '') || depth >= 2) continue;
      const inner = classifyCommand(unquote(toks.slice(i + 2).join(' ')), depth + 1);
      if (inner) consider(inner, inner === 'Build' ? 1 : 3);
      continue;
    }
    const known = KNOWN.find(([re]) => re.test(base))?.[1];
    if (known) consider(known, known === 'Build' ? 1 : 3);
    else if (/^(\.{1,2}\/|\/|~\/)/.test(exe) && /^[A-Za-z][\w.+-]+$/.test(base) && !NOT_PROGRAMS.test(base)) consider(base, 2);
  }
  if (!best) return undefined;
  // `cd micromegas/MSSM && make && ./main data.par` is micrOMEGAs, not "Build" or "main".
  if (best.rank <= 2) for (const [re, p] of BY_PATH) if (re.test(cmd)) return p;
  return best.program;
}

/** Program a tool call runs, or undefined when it isn't a computation. */
export function classifyCompute(toolName: string, input: string): string | undefined {
  if (/wolfram/i.test(toolName)) return 'Wolfram';
  if (/mathematica/i.test(toolName)) return 'Mathematica';
  if (/notebook/i.test(toolName) && /python|ipynb/i.test(input)) return 'Python';
  const cmd = shellCommand(toolName, input);
  return cmd ? classifyCommand(cmd) : undefined;
}
