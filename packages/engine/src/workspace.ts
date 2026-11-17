import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execText } from './adapters/proc.ts';

const git = (cwd: string, ...args: string[]) => execText('git', args, cwd, 60_000);

export interface RepoInfo {
  isRepo: boolean;
  root?: string;
  branch?: string;
  head?: string;
  dirty?: number;
  untracked?: number;
  remotes?: { name: string; url: string }[];
  ahead?: number;
  behind?: number;
  ghAuthenticated?: boolean;
  userName?: string;
}

/** Inspect a workspace's git state. Never reads or prints credentials. */
export async function repoInfo(path: string, checkGh = false): Promise<RepoInfo> {
  const root = await git(path, 'rev-parse', '--show-toplevel');
  if (root.code !== 0) return { isRepo: false };
  const r = root.stdout.trim();
  const [branch, head, status, remotes, ab, name] = await Promise.all([
    git(r, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(r, 'rev-parse', '--short', 'HEAD'),
    git(r, 'status', '--porcelain'),
    git(r, 'remote', '-v'),
    git(r, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'),
    git(r, 'config', 'user.name'),
  ]);
  const lines = status.stdout.split('\n').filter(Boolean);
  const seen = new Set<string>();
  const rem = remotes.stdout
    .split('\n')
    .filter((l) => l.endsWith('(fetch)'))
    .map((l) => {
      const [n, u] = l.split(/\s+/);
      return { name: n, url: u.replace(/\/\/[^@/]+@/, '//') }; // strip embedded credentials
    })
    .filter((x) => !seen.has(x.name) && seen.add(x.name));
  const [behind, ahead] = ab.code === 0 ? ab.stdout.trim().split(/\s+/).map(Number) : [undefined, undefined];
  let ghAuthenticated: boolean | undefined;
  if (checkGh) ghAuthenticated = (await execText('gh', ['auth', 'status'], r, 10_000)).code === 0;
  return {
    isRepo: true,
    root: r,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    dirty: lines.filter((l) => !l.startsWith('??')).length,
    untracked: lines.filter((l) => l.startsWith('??')).length,
    remotes: rem,
    ahead,
    behind,
    ghAuthenticated,
    userName: name.stdout.trim() || undefined,
  };
}

/**
 * Per-run integration branch plus per-task worktrees. Write tasks never touch
 * the user's checkout: each works in its own worktree branched from the
 * integration branch, and verified work is merged into the integration
 * branch locally. Publishing (merge to the user's branch, push, PR) needs
 * explicit approval.
 */
export class Worktrees {
  private baseDir: string;
  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private locks = new Map<string, Promise<unknown>>();

  /** Serialize git operations per repository (worktree/ref creation races otherwise). */
  private serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(repo, next.catch(() => {}));
    return next;
  }

  integrationBranch(runId: string) {
    return `synape/${runId.slice(0, 8)}`;
  }

  integrationPath(runId: string) {
    return join(this.baseDir, runId, '_integration');
  }

  ensureIntegration(repoRoot: string, runId: string): Promise<string> {
    return this.serial(repoRoot, () => this.ensureIntegrationUnlocked(repoRoot, runId));
  }

  private async ensureIntegrationUnlocked(repoRoot: string, runId: string): Promise<string> {
    const p = this.integrationPath(runId);
    if (existsSync(p)) return p;
    mkdirSync(join(this.baseDir, runId), { recursive: true });
    const br = this.integrationBranch(runId);
    const exists = (await git(repoRoot, 'rev-parse', '--verify', br)).code === 0;
    const res = exists ? await git(repoRoot, 'worktree', 'add', p, br) : await git(repoRoot, 'worktree', 'add', '-b', br, p, 'HEAD');
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);
    return p;
  }

  forTask(repoRoot: string, runId: string, taskId: string): Promise<{ path: string; branch: string }> {
    return this.serial(repoRoot, () => this.forTaskUnlocked(repoRoot, runId, taskId));
  }

  private async forTaskUnlocked(repoRoot: string, runId: string, taskId: string): Promise<{ path: string; branch: string }> {
    await this.ensureIntegrationUnlocked(repoRoot, runId);
    const path = join(this.baseDir, runId, taskId);
    const branch = `${this.integrationBranch(runId)}-${taskId.slice(0, 8)}`;
    if (existsSync(path)) return { path, branch };
    const exists = (await git(repoRoot, 'rev-parse', '--verify', branch)).code === 0;
    const res = exists ? await git(repoRoot, 'worktree', 'add', path, branch) : await git(repoRoot, 'worktree', 'add', '-b', branch, path, this.integrationBranch(runId));
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);
    return { path, branch };
  }

  /** Diff of everything the agent changed in its worktree, including new files. */
  async diff(path: string): Promise<string> {
    await git(path, 'add', '-A', '-N');
    const d = await git(path, 'diff', 'HEAD', '--stat', '--patch');
    return d.stdout;
  }

  async changedFiles(path: string): Promise<string[]> {
    const s = await git(path, 'status', '--porcelain');
    return s.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3));
  }

  /** Commit task work on its branch and merge into the run's integration branch. */
  integrate(runId: string, taskPath: string, branch: string, message: string): Promise<{ ok: boolean; conflict?: string; commit?: string }> {
    return this.serial(`integrate:${runId}`, () => this.integrateUnlocked(runId, taskPath, branch, message));
  }

  private async integrateUnlocked(runId: string, taskPath: string, branch: string, message: string): Promise<{ ok: boolean; conflict?: string; commit?: string }> {
    const files = await this.changedFiles(taskPath);
    if (files.length) {
      await git(taskPath, 'add', '-A');
      const c = await git(taskPath, 'commit', '-m', message);
      if (c.code !== 0) return { ok: false, conflict: c.stderr || c.stdout };
    }
    const ip = this.integrationPath(runId);
    const m = await git(ip, 'merge', '--no-ff', '-m', `Merge ${branch}`, branch);
    if (m.code !== 0) {
      await git(ip, 'merge', '--abort');
      return { ok: false, conflict: (m.stdout + m.stderr).slice(0, 2000) };
    }
    const head = await git(ip, 'rev-parse', '--short', 'HEAD');
    return { ok: true, commit: head.stdout.trim() };
  }
}
