import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, foldEvents, initialState, type ModelProfile, type RunState } from '@synape/core';
import { Engine } from '../src/engine.ts';
import { EventStore } from '../src/store.ts';
import { ScriptedAdapter, isPlan, isReview, isSynth, plannedTask, type Script } from './fakes.ts';

const MODELS: Omit<ModelProfile, 'available'>[] = [
  { id: 'a:light', provider: 'a', model: 'light', label: 'A light', billing: 'subscription', tier: 1, contextWindow: 200000, skill: { analysis: 0.6, review: 0.6, planning: 0.6, writing: 0.6, coding: 0.6 }, ruPer1kTokens: 1, latencyFactor: 1 },
  { id: 'a:strong', provider: 'a', model: 'strong', label: 'A strong', billing: 'subscription', tier: 3, contextWindow: 200000, skill: { analysis: 0.95, review: 0.95, planning: 0.95, writing: 0.95, coding: 0.95 }, ruPer1kTokens: 5, latencyFactor: 1 },
  { id: 'b:mid', provider: 'b', model: 'mid', label: 'B mid', billing: 'subscription', tier: 2, contextWindow: 200000, skill: { analysis: 0.85, review: 0.85, planning: 0.8, writing: 0.8, coding: 0.9 }, ruPer1kTokens: 2, latencyFactor: 1 },
];

function setup(script: Script, dir = mkdtempSync(join(tmpdir(), 'synape-test-'))) {
  const store = new EventStore(join(dir, 'db.sqlite'));
  const a = new ScriptedAdapter('a', script);
  const b = new ScriptedAdapter('b', script);
  const engine = new Engine({ store, adapters: [a, b], dataDir: dir, models: MODELS });
  return { engine, store, a, b, dir };
}

function waitFor(engine: Engine, runId: string, pred: (s: RunState) => boolean, ms = 8000): Promise<RunState> {
  return new Promise((ok, fail) => {
    const check = () => {
      const s = engine.state(runId);
      if (pred(s)) {
        unsub();
        clearTimeout(t);
        ok(s);
        return true;
      }
      return false;
    };
    const unsub = engine.store.subscribe(runId, () => setImmediate(check));
    const t = setTimeout(() => {
      unsub();
      fail(new Error(`timeout; state: ${JSON.stringify(Object.values(engine.state(runId).tasks).map((t) => [t.title, t.status, t.statusReason]))}`));
    }, ms);
    if (check()) return;
  });
}

const done = (s: RunState) => ['completed', 'failed', 'cancelled'].includes(s.run.status);

describe('engine', () => {
  it('plans, runs dependencies in order, parallelizes independent tasks and synthesizes', async () => {
    const order: string[] = [];
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'plan', reply: 'ok', tasks: [plannedTask('x'), plannedTask('y'), plannedTask('z', { deps: ['x', 'y'] })] } };
      if (isSynth(spec)) return { text: '## Summary\nall good' };
      const k = spec.prompt.match(/## Your task: Task (\w)/)?.[1] ?? '?';
      order.push(`start ${k}`);
      return { text: `## Summary\nresult ${k}`, delayMs: 30 };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'test objective', workspace: process.cwd() });
    const s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('completed');
    const z = Object.values(s.tasks).find((t) => t.title === 'Task z')!;
    const x = Object.values(s.tasks).find((t) => t.title === 'Task x')!;
    const y = Object.values(s.tasks).find((t) => t.title === 'Task y')!;
    expect(z.startedAt!).toBeGreaterThanOrEqual(Math.max(x.endedAt!, y.endedAt!));
    // x and y overlapped (parallel)
    expect(x.startedAt!).toBeLessThan(y.endedAt!);
    expect(y.startedAt!).toBeLessThan(x.endedAt!);
    expect(s.run.finalArtifactId).toBeTruthy();
    // z received dependency summaries, not full history
    expect(order.at(-1)).toBe('start z');
  });

  it('independent review rejects, author revises, then passes; reviewer differs from author', async () => {
    let reviews = 0;
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('w', { verification: 'review', criticality: 3 })] } };
      if (isReview(spec)) {
        reviews++;
        return { structured: reviews === 1 ? { verdict: 'revise', confidence: 0.8, summary: 'missing units', issues: [{ severity: 'major', description: 'no units' }] } : { verdict: 'pass', confidence: 0.9, summary: 'ok now', issues: [] } };
      }
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return { text: spec.prompt.includes('missing units') ? '## Summary\nfixed with units' : '## Summary\nfirst' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'review test', workspace: process.cwd() });
    const s = await waitFor(engine, runId, done);
    const w = Object.values(s.tasks).find((t) => t.title === 'Task w')!;
    expect(w.verified).toBe(true);
    expect(w.attempts).toBe(2);
    expect(w.reviewIds).toHaveLength(2);
    const verdicts = w.reviewIds.map((r) => s.reviews[r]);
    expect(verdicts.map((v) => v.verdict)).toEqual(['revise', 'pass']);
    w.agentIds.forEach((authorId, i) => {
      const author = s.agents[authorId];
      const reviewer = s.agents[verdicts[i].reviewerAgentId];
      expect(reviewer.id).not.toBe(author.id);
      // other model family preferred when available
      expect(reviewer.provider).not.toBe(author.provider);
    });
  });

  it('preserves unresolved disagreement instead of forcing consensus', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('d', { verification: 'review' })] } };
      if (isReview(spec)) return { structured: { verdict: 'revise', confidence: 0.7, summary: 'still wrong', issues: [] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return { text: '## Summary\nclaim' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'disagree', workspace: process.cwd(), config: { limits: { maxRetries: 1, maxAgentsPerTask: 10 } as any } });
    const s = await waitFor(engine, runId, done);
    const d = Object.values(s.tasks).find((t) => t.title === 'Task d')!;
    expect(d.status).toBe('completed');
    expect(d.verified).toBe(false);
    expect(d.resultSummary).toMatch(/UNRESOLVED REVIEW DISAGREEMENT/);
  });

  it('escalates to a stronger tier after repeated failure', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('e', { complexity: 1 })] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      if (spec.model === 'strong') return { text: '## Summary\nsolved' };
      return { ok: false, error: 'could not solve', errorClass: 'task' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'escalate', workspace: process.cwd(), config: { limits: { maxRetries: 3, maxAgentsPerTask: 10 } as any, providers: ['a'] } });
    const s = await waitFor(engine, runId, done);
    const e = Object.values(s.tasks).find((t) => t.title === 'Task e')!;
    expect(e.status).toBe('completed');
    expect(s.escalations.length).toBeGreaterThan(0);
    expect(s.agents[e.agentIds.at(-1)!].model).toBe('strong');
  });

  it('promotes a worker to sub-orchestrator and bounds depth', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('big')] } };
      if (isSynth(spec)) return { text: '## Summary\nsynth' };
      if (spec.prompt.includes('## Your task: Task big') && spec.prompt.includes('synape-delegate'))
        return { text: '```synape-delegate\n' + JSON.stringify({ reason: 'large', tasks: [plannedTask('s1'), plannedTask('s2'), plannedTask('s3', { kind: 'orchestrate' })] }) + '\n```' };
      return { text: '## Summary\nleaf' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'delegate', workspace: process.cwd(), config: { limits: { maxDepth: 2 } as any } });
    const s = await waitFor(engine, runId, done);
    const big = Object.values(s.tasks).find((t) => t.title === 'Task big')!;
    expect(big.status).toBe('completed');
    const kids = Object.values(s.tasks).filter((t) => t.parentTaskId === big.id);
    expect(kids.map((k) => k.title).sort()).toEqual(['Synthesize: Task big', 'Task s1', 'Task s2', 'Task s3']);
    // depth 2 == maxDepth → orchestrate request downgraded to work
    expect(kids.find((k) => k.title === 'Task s3')!.kind).toBe('work');
    expect(s.agents[big.agentIds[0]].role).toBe('sub_orchestrator');
    expect(s.limitEvents.some((l) => l.limit === 'maxDepth')).toBe(true);
  });

  it('rejects cyclic plans and retries planning', async () => {
    let plans = 0;
    const { engine } = setup((spec) => {
      if (isPlan(spec)) {
        plans++;
        return plans === 1
          ? { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('p', { deps: ['q'] }), plannedTask('q', { deps: ['p'] })] } }
          : { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('p')] } };
      }
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return { text: '## Summary\nok' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'cycle', workspace: process.cwd() });
    const s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('completed');
    expect(plans).toBe(2);
  });

  it('routes around provider failures without blaming the model', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('r', { category: 'coding' })] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      if (spec.model === 'light') return { ok: false, error: '429 rate limit', errorClass: 'provider' };
      return { text: '## Summary\nok' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'provider fail', workspace: process.cwd() });
    const s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('completed');
    expect(Object.values(s.tasks).some((t) => t.excludedModels.includes('a:light'))).toBe(true);
    // provider errors are not recorded as model capability failures
    expect((engine.store.perfTable() as any[]).filter((r) => r.modelId === 'a:light' && r.successes < r.n)).toHaveLength(0);
  });

  it('usage limits pause the run without spending retries, then resume cleanly', async () => {
    let limited = true;
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('q')] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      if (limited) return { ok: false, error: "You've hit your usage limit. Try again in 2 hours.", errorClass: 'quota' };
      return { text: '## Summary\nok' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'quota', workspace: process.cwd() });
    let s = await waitFor(engine, runId, (x) => x.run.status === 'paused');
    const q = Object.values(s.tasks).find((t) => t.title === 'Task q')!;
    expect(q.status).toBe('ready');
    expect(q.excludedModels).toEqual([]);
    expect(s.run.resumeAt! - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(Object.values(s.agents).filter((a) => a.taskId === q.id).every((a) => a.status === 'interrupted')).toBe(true);
    limited = false;
    engine.resume(runId);
    s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('completed');
    expect(s.run.resumeAt).toBeUndefined();
    await engine.shutdown();
  });

  it('resuming a failed run reopens failed tasks with a fresh retry budget', async () => {
    let broken = true;
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('f'), plannedTask('g', { deps: ['f'] })] } };
      if (broken) return { ok: false, error: 'boom', errorClass: 'task' };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return { text: '## Summary\nok' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'reopen', workspace: process.cwd() });
    let s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('failed');
    broken = false;
    engine.resume(runId);
    s = await waitFor(engine, runId, (x) => x.run.status === 'completed');
    expect(Object.values(s.tasks).every((t) => t.status === 'completed')).toBe(true);
  });

  it('models off by default are never routed to until enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synape-test-'));
    const store = new EventStore(join(dir, 'db.sqlite'));
    const script: Script = (spec) => (isPlan(spec) ? { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('o')] } } : { text: '## Summary\nok' });
    const a = new ScriptedAdapter('a', script);
    const models = MODELS.map((m) => (m.id === 'a:strong' ? { ...m, defaultEnabled: false } : m));
    const engine = new Engine({ store, adapters: [a, new ScriptedAdapter('b', script)], dataDir: dir, models });
    await engine.init();
    expect(engine.models.find((m) => m.id === 'a:strong')).toMatchObject({ disabled: true, available: false });
    const runId = engine.createRun({ objective: 'opt-in', workspace: process.cwd() });
    const s = await waitFor(engine, runId, done);
    expect(Object.values(s.agents).some((x) => x.modelId === 'a:strong')).toBe(false);
    engine.setModelEnabled('a:strong', true);
    // persisted: a fresh engine on the same data dir sees it enabled
    const again = new Engine({ store, adapters: [a], dataDir: dir, models });
    await again.init();
    expect(again.models.find((m) => m.id === 'a:strong')?.disabled).toBe(false);
  });

  it('user can switch a running task to another model without spending a retry', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('m')] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return spec.model === 'mid' ? { text: '## Summary\nby mid' } : { text: '## Summary\nslow', delayMs: 5000 };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'pin', workspace: process.cwd() });
    let s = await waitFor(engine, runId, (x) => Object.values(x.tasks).some((t) => t.title === 'Task m' && t.status === 'running'));
    const t = Object.values(s.tasks).find((x) => x.title === 'Task m')!;
    if (s.agents[t.agentIds.at(-1)!].modelId === 'b:mid') return; // router already chose it; nothing to switch
    engine.setTaskModel(runId, t.id, 'b:mid');
    s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('completed');
    const agents = s.tasks[t.id].agentIds.map((x) => s.agents[x]);
    expect(agents.at(-1)!.modelId).toBe('b:mid');
    expect(agents.slice(0, -1).every((x) => x.status === 'interrupted')).toBe(true);
    expect(s.tasks[t.id].routing?.explanation).toMatch(/chosen by user/);
  });

  it('cancellation propagates to descendants and running agents', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('slow'), plannedTask('after', { deps: ['slow'] })] } };
      return { text: '## Summary\nok', delayMs: 5000 };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'cancel', workspace: process.cwd() });
    await waitFor(engine, runId, (s) => Object.values(s.agents).some((a) => a.status === 'running' && s.tasks[a.taskId].title === 'Task slow'));
    engine.cancelRun(runId);
    const s = await waitFor(engine, runId, (s) => Object.values(s.agents).every((a) => a.status !== 'running' && a.status !== 'starting'));
    expect(s.run.status).toBe('cancelled');
    expect(Object.values(s.tasks).every((t) => ['cancelled', 'completed'].includes(t.status) || t.kind === 'plan')).toBe(true);
  });

  it('enforces the permission ceiling through approvals', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('net', { permission: 'network' })] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return { text: `## Summary\nperm=${spec.permission}` };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'perm', workspace: process.cwd() });
    let s = await waitFor(engine, runId, (s) => Object.values(s.approvals).length > 0);
    const ap = Object.values(s.approvals)[0];
    expect(ap.kind).toBe('permission');
    expect(Object.values(s.tasks).find((t) => t.title === 'Task net')!.status).toBe('blocked');
    engine.resolveApproval(runId, ap.id, false);
    s = await waitFor(engine, runId, done);
    expect(Object.values(s.tasks).find((t) => t.title === 'Task net')!.resultSummary).toBe('perm=read');
  });

  it('survives restart: state rebuilds from disk and interrupted work resumes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synape-recover-'));
    let first = true;
    const script: Script = (spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('long')] } };
      if (isSynth(spec)) return { text: '## Summary\ns' };
      return first ? { text: '## Summary\nx', delayMs: 10_000 } : { text: '## Summary\nresumed' };
    };
    const one = setup(script, dir);
    await one.engine.init();
    const runId = one.engine.createRun({ objective: 'recover', workspace: process.cwd() });
    await waitFor(one.engine, runId, (s) => Object.values(s.agents).some((a) => a.status === 'running' && s.tasks[a.taskId].title === 'Task long'));
    const before = JSON.parse(JSON.stringify(one.engine.state(runId)));
    // Simulate a crash: drop the engine without graceful shutdown bookkeeping.
    (one.engine as any).shuttingDown = true;
    first = false;
    one.store.close();

    const two = setup(script, dir);
    // Projection rebuilt purely from persisted events equals the live one.
    const rebuilt = two.store.state(runId);
    expect(rebuilt.lastSeq).toBeGreaterThanOrEqual(before.lastSeq);
    expect(Object.keys(rebuilt.tasks)).toEqual(Object.keys(before.tasks));
    await two.engine.init();
    const s = await waitFor(two.engine, runId, done);
    expect(s.run.status).toBe('completed');
    const long = Object.values(s.tasks).find((t) => t.title === 'Task long')!;
    expect(s.agents[long.agentIds[0]].status).toBe('interrupted');
    expect(long.resultSummary).toBe('resumed');
    // The resumed attempt reused the interrupted session.
    expect(two.a.calls.concat(two.b.calls).some((c) => c.resumeSessionId?.startsWith('sess-'))).toBe(true);
    // Full replay from the event log reproduces the live state exactly.
    const replayed = foldEvents(two.store.events(runId), initialState(runId));
    expect(canonicalize(replayed)).toEqual(canonicalize(two.engine.state(runId)));
  });

  it('follow-up instructions extend a completed run with new tasks and a new synthesis', async () => {
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('first')] } };
      if (spec.jsonSchema && 'cancel' in (spec.jsonSchema as any).properties) return { structured: { reply: 'adding', add: [plannedTask('extra')], cancel: [] } };
      if (isSynth(spec)) return { text: '## Summary\nsynth' };
      return { text: '## Summary\nok' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'followup', workspace: process.cwd() });
    await waitFor(engine, runId, done);
    engine.postMessage(runId, 'also do the extra thing');
    const s = await waitFor(engine, runId, (s) => s.run.status === 'completed' && Object.values(s.tasks).some((t) => t.title === 'Task extra' && t.status === 'completed') && Object.values(s.tasks).filter((t) => t.kind === 'synthesize').every((t) => t.status === 'completed'));
    expect(Object.values(s.tasks).filter((t) => t.kind === 'synthesize')).toHaveLength(2);
  });
});

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

describe('git workspaces', () => {
  it('runs writers in isolated worktrees, reviewers in the author worktree, and merges verified work', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'synape-repo-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    const cwds: Record<string, string> = {};
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('w', { permission: 'execute', verification: 'review' })] } };
      if (isReview(spec)) {
        cwds.review = spec.cwd;
        return { structured: { verdict: 'pass', confidence: 0.9, summary: 'ok', issues: [] } };
      }
      if (isSynth(spec)) return { text: '## Summary\ns' };
      cwds.author = spec.cwd;
      writeFileSync(join(spec.cwd, 'b.txt'), 'two\n');
      return { text: `## Summary\nwrote b.txt in ${spec.cwd}` };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'git test', workspace: repo, config: { permissionCeiling: 'execute' } });
    const s = await waitFor(engine, runId, done, 20000);
    expect(s.run.status).toBe('completed');
    expect(cwds.author).not.toBe(repo);
    expect(cwds.review).toBe(cwds.author);
    // user's checkout untouched; verified work merged into the run branch
    expect(git('status', '--porcelain')).toBe('');
    expect(git('show', `synape/${runId.slice(0, 8)}:b.txt`)).toBe('two\n');
    // downstream agents see neutral paths, not another task's worktree
    expect(engine.neutralizePaths(runId, `see ${cwds.author}/b.txt`)).toBe(`see ${repo}/b.txt`);
    // no boundary violations reported
    expect(s.messages.some((m) => m.text.includes('Boundary audit'))).toBe(false);
  });
});

describe('research outputs', () => {
  it('records files an agent produced, snapshots figures, and carries the TL;DR to the run', async () => {
    const { mkdtempSync: mk, writeFileSync: wf, utimesSync } = await import('node:fs');
    const ws = mk(join(tmpdir(), 'synape-ws-'));
    wf(join(ws, 'old.txt'), 'pre-existing');
    utimesSync(join(ws, 'old.txt'), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const { engine } = setup((spec) => {
      if (isPlan(spec)) return { structured: { summary: 'p', reply: 'ok', tasks: [plannedTask('fig', { permission: 'write' })] } };
      if (isSynth(spec)) return { text: '## TL;DR\n- m = 125.1 ± 0.2\n- verified\n## Summary\nlong form' };
      wf(join(spec.cwd, 'plot.png'), 'PNG');
      wf(join(spec.cwd, 'fit.py'), 'print(1)');
      return { text: '## Summary\nmade a plot' };
    });
    await engine.init();
    const runId = engine.createRun({ objective: 'make a figure', workspace: ws, config: { permissionCeiling: 'write' } });
    const s = await waitFor(engine, runId, done);
    expect(s.run.status).toBe('completed');
    const t = Object.values(s.tasks).find((x) => x.title === 'Task fig')!;
    const rels = (t.outputs ?? []).map((f) => f.rel);
    expect(rels).toContain('plot.png');
    expect(rels).toContain('fit.py');
    expect(rels).not.toContain('old.txt');
    expect(t.outputs!.find((f) => f.rel === 'plot.png')!.snapshot).toMatch(/outputs/);
    expect(s.tasks[s.run.rootTaskId!].resultTldr).toMatch(/m = 125.1/);
  });

  it('resolves the figures a manuscript includes, following \\input from the main document', async () => {
    const { mkdtempSync: mk, writeFileSync: wf, mkdirSync: md } = await import('node:fs');
    const { texGraphics } = await import('../src/outputs.ts');
    const ws = mk(join(tmpdir(), 'synape-tex-'));
    md(join(ws, 'sections'));
    md(join(ws, 'figures'));
    md(join(ws, 'vendor/man'), { recursive: true });
    wf(join(ws, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/res}\n% \\includegraphics{commented}\n\\end{document}');
    wf(join(ws, 'sections/res.tex'), '\\includegraphics[width=\\linewidth]{figures/spectrum.pdf}\n\\includegraphics{missing_one}');
    wf(join(ws, 'figures/spectrum.pdf'), '%PDF');
    wf(join(ws, 'vendor/man/manual.tex'), '\\documentclass{book}\\includegraphics{vendor_fig}');
    const tex = texGraphics(ws);
    expect(tex.mains).toEqual(['main.tex']);
    expect(tex.names.sort()).toEqual(['missing_one', 'spectrum']);
    expect(tex.figures.find((f) => f.name === 'spectrum')?.rel).toBe('figures/spectrum.pdf');
  });
});
