import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type ProcLine = { stream: 'stdout' | 'stderr'; line: string } | { stream: 'exit'; code: number | null; signal: string | null; reason?: 'timeout' | 'cancelled' } | { stream: 'pid'; pid: number } | { stream: 'error'; error: Error };

/**
 * Spawn a CLI and yield its output line by line. The process gets its own
 * process group so cancellation kills the whole tree (agent + its tools).
 */
export async function* runProcess(cmd: string, args: string[], opts: { cwd: string; stdin?: string; signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv }): AsyncGenerator<ProcLine> {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const queue: ProcLine[] = [];
  let wake: (() => void) | null = null;
  const push = (l: ProcLine) => {
    queue.push(l);
    wake?.();
  };
  let reason: 'timeout' | 'cancelled' | undefined;
  const kill = (r: 'timeout' | 'cancelled') => {
    if (reason) return;
    reason = r;
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }, 5000).unref();
  };
  const onAbort = () => kill('cancelled');
  if (opts.signal.aborted) onAbort();
  opts.signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
  timer.unref();

  child.on('error', (error) => push({ stream: 'error', error }));
  if (child.pid) push({ stream: 'pid', pid: child.pid });
  let open = 2;
  const done = () => {
    if (--open === 0) maybeExit();
  };
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  const maybeExit = () => {
    if (open === 0 && exitInfo) push({ stream: 'exit', ...exitInfo, reason });
  };
  createInterface({ input: child.stdout }).on('line', (line) => push({ stream: 'stdout', line })).on('close', done);
  createInterface({ input: child.stderr }).on('line', (line) => push({ stream: 'stderr', line })).on('close', done);
  child.on('close', (code, signal) => {
    exitInfo = { code, signal };
    maybeExit();
  });
  child.stdin.on('error', () => {});
  child.stdin.end(opts.stdin ?? '');

  try {
    while (true) {
      while (queue.length) {
        const l = queue.shift()!;
        yield l;
        if (l.stream === 'exit' || l.stream === 'error') return;
      }
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
    if (child.exitCode === null && !reason) kill('cancelled');
  }
}

export function execText(cmd: string, args: string[], cwd = process.cwd(), timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}
