#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billableTokens, canonicalize, foldEvents, initialState, type EventEnvelope, type PermissionLevel, type RunState } from '@synape/core';
import { createEngine, dataDir, EventStore, startServer } from './index.ts';

const HELP = `synape — event-sourced multi-provider agent orchestration

Usage:
  synape serve [--port 7420]                  start the engine + web UI (http://127.0.0.1:7420)
  synape run "<objective>" [options]          run headless in this terminal until done
      --workspace <dir>   (default: cwd)       --ceiling read|write|execute|network
      --extra-dir <dir>   (repeatable)         --max-depth <n>   --max-agents <n>
      --providers claude-code,codex            --max-tokens <n>  --quality <0..1>
      --auto-approve      approve permission requests up to the ceiling+1 automatically
  synape providers                            detect providers and list models
  synape ls                                   list runs
  synape status <runId> [--at <seq>]          summarize a run (optionally as of an event seq)
  synape events <runId> [--type t1,t2]        dump the event log as JSON lines
  synape verify [runId]                       check that replaying the log reproduces the persisted state
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: process.env.SYNAPE_PORT ?? '7420' },
    workspace: { type: 'string' },
    ceiling: { type: 'string' },
    'extra-dir': { type: 'string', multiple: true },
    'max-depth': { type: 'string' },
    'max-agents': { type: 'string' },
    'max-tokens': { type: 'string' },
    providers: { type: 'string' },
    quality: { type: 'string' },
    'auto-approve': { type: 'boolean' },
    at: { type: 'string' },
    type: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const cmd = positionals[0];
const dir = dataDir();

function lock(): () => void {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'engine.lock');
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && pid !== process.pid) {
      console.error(`Another synape engine (pid ${pid}) owns ${dir}. Use its UI/API, or stop it first.`);
      process.exit(1);
    }
  }
  writeFileSync(f, String(process.pid));
  return () => {
    try {
      unlinkSync(f);
    } catch {}
  };
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function summarize(s: RunState) {
  const lines = [`${s.run.title}  [${s.run.status}]  ${s.run.id}`, `workspace: ${s.run.workspace}`, ''];
  const byParent = new Map<string | undefined, typeof s.tasks[string][]>();
  for (const t of Object.values(s.tasks)) {
    const k = t.parentTaskId;
    byParent.set(k, [...(byParent.get(k) ?? []), t]);
  }
  const walk = (pid: string | undefined, ind: string) => {
    for (const t of byParent.get(pid) ?? []) {
      const a = s.agents[t.agentIds.at(-1) ?? ''];
      lines.push(`${ind}${t.status.padEnd(15)} ${t.kind.padEnd(11)} ${t.title}${a ? `  · ${a.modelId}` : ''}${t.verified ? ' ✓verified' : ''}`);
      walk(t.id, ind + '  ');
    }
  };
  walk(undefined, '');
  lines.push('', `agents: ${Object.keys(s.agents).length}  tokens: ${fmt(billableTokens(s.totals))} (+${fmt(s.totals.cacheReadTokens)} cache-read)  retry: ${fmt(s.totals.retryTokens)}  review: ${fmt(s.totals.reviewTokens)}`);
  for (const [p, u] of Object.entries(s.usageByProvider)) lines.push(`  ${p}: ${fmt(billableTokens(u))} tokens${u.costUsd !== undefined ? `, $${u.costUsd.toFixed(3)} (${u.costBasis})` : ', cost unavailable'}`);
  return lines.join('\n');
}

function printEvent(e: EventEnvelope, s: RunState) {
  const b = e.body;
  const t = new Date(e.ts).toISOString().slice(11, 19);
  const agent = (id: string) => {
    const a = s.agents[id];
    return a ? `${a.role}:${s.tasks[a.taskId]?.title.slice(0, 28)}@${a.modelId}` : id;
  };
  switch (b.type) {
    case 'task.created':
      return console.log(`${t} + task   ${b.kind.padEnd(11)} ${b.title}${b.deps.length ? `  (after ${b.deps.length})` : ''}`);
    case 'task.status':
      return console.log(`${t} ~ task   ${b.status.padEnd(15)} ${s.tasks[b.taskId]?.title}${b.reason ? `  — ${b.reason}` : ''}`);
    case 'task.routed':
      return console.log(`${t} → route  ${b.decision.explanation.replace(/\n/g, ' · ')}`);
    case 'agent.spawned':
      return console.log(`${t} ● spawn  ${agent(b.agentId)}`);
    case 'agent.status':
      if (b.status !== 'running') console.log(`${t} ○ agent  ${b.status.padEnd(11)} ${agent(b.agentId)}${b.reason ? `  — ${b.reason}` : ''}`);
      return;
    case 'tool.started':
      return console.log(`${t}   tool   ${agent(b.agentId).split('@')[0]} ${b.name} ${b.input.slice(0, 90)}`);
    case 'review.verdict':
      return console.log(`${t} ⚖ review ${b.verdict} (${b.confidence}) ${s.tasks[b.targetTaskId]?.title}: ${b.summary.slice(0, 120)}`);
    case 'task.escalated':
      return console.log(`${t} ⇑ escal  ${s.tasks[b.taskId]?.title}: tier≥${b.minTier} — ${b.reason}`);
    case 'chat.message':
      return console.log(`${t} ✉ ${b.from}: ${b.text.slice(0, 400)}`);
    case 'approval.requested':
      return console.log(`${t} ? approval ${b.kind}: ${b.description}`);
    case 'limit.hit':
      return console.log(`${t} ! limit  ${b.limit}: ${b.detail}`);
    case 'error':
      return console.log(`${t} ! error  ${b.message.slice(0, 200)}`);
    case 'run.status':
      return console.log(`${t} ■ run    ${b.status}${b.reason ? ` — ${b.reason}` : ''}`);
    case 'delegation.decided':
      return console.log(`${t} ⤳ deleg  ${b.approved ? 'approved' : 'denied'}: ${b.reason}`);
  }
}

async function main() {
  if (o.help || !cmd) return console.log(HELP);
  if (cmd === 'serve') {
    const unlock = lock();
    const engine = await createEngine({ log: (m) => console.error(m) });
    const here = dirname(fileURLToPath(import.meta.url));
    const uiDir = resolve(here, '../../ui/dist');
    const port = Number(o.port);
    const srv = startServer({ engine, port, uiDir });
    for (const p of engine.providers.values()) console.log(`  ${p.available ? '✓' : '✗'} ${p.label} ${p.version ?? ''} ${p.auth ?? p.reason ?? ''}`);
    console.log(`\n  synape listening on http://127.0.0.1:${port}\n  data: ${dir}\n`);
    const stop = async () => {
      console.log('\nshutting down: running agents will be marked interrupted and resumed on next start…');
      await engine.shutdown();
      await srv.close();
      engine.store.close();
      unlock();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (cmd === 'run') {
    const objective = positionals.slice(1).join(' ');
    if (!objective) return console.error('objective required');
    const unlock = lock();
    const engine = await createEngine({ log: (m) => console.error(m) });
    const ceiling = (o.ceiling ?? 'read') as PermissionLevel;
    const runId = engine.createRun({
      objective,
      workspace: resolve(o.workspace ?? process.cwd()),
      config: {
        permissionCeiling: ceiling,
        extraDirs: (o['extra-dir'] ?? []).map((d) => resolve(d)),
        providers: o.providers?.split(','),
        qualityBias: o.quality ? Number(o.quality) : 0.5,
        limits: {
          ...(o['max-depth'] ? { maxDepth: Number(o['max-depth']) } : {}),
          ...(o['max-agents'] ? { maxConcurrentAgents: Number(o['max-agents']) } : {}),
        } as any,
        budgets: o['max-tokens'] ? { maxTokens: Number(o['max-tokens']) } : {},
      },
    });
    console.log(`run ${runId}\n`);
    const done = new Promise<void>((ok) => {
      engine.store.subscribe(runId, (e) => {
        const s = engine.state(runId);
        printEvent(e, s);
        if (e.body.type === 'approval.requested' && o['auto-approve'] && e.body.kind === 'permission') setImmediate(() => engine.resolveApproval(runId, (e.body as any).id, true, 'auto-approved by CLI flag'));
        if (e.body.type === 'run.status' && ['completed', 'failed', 'cancelled'].includes(e.body.status)) ok();
        if (e.body.type === 'run.status' && e.body.status === 'paused') ok();
      });
    });
    let stopping = false;
    process.on('SIGINT', async () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log('\ninterrupting: agents will be resumable via `synape serve`');
      await engine.shutdown();
      unlock();
      process.exit(130);
    });
    await done;
    await new Promise((r) => setTimeout(r, 300));
    console.log(`\n${summarize(engine.state(runId))}`);
    engine.store.close();
    unlock();
    return;
  }
  if (cmd === 'providers') {
    const engine = await createEngine({ dir: join(dir, '.probe') });
    for (const p of engine.providers.values()) console.log(`${p.available ? '✓' : '✗'} ${p.label.padEnd(12)} ${p.version ?? ''}  ${p.auth ?? p.reason ?? ''}  billing: ${p.billing}`);
    console.log('');
    for (const m of engine.models) console.log(`  ${m.available ? '●' : '○'} ${m.id.padEnd(28)} tier ${m.tier}  ${m.ruPer1kTokens} RU/1k  ctx ${fmt(m.contextWindow)}`);
    return;
  }
  const store = new EventStore(join(dir, 'synape.db'));
  if (cmd === 'ls') {
    for (const r of store.listRuns()) console.log(`${r.id}  ${r.status.padEnd(10)} ${new Date(r.createdAt).toISOString().slice(0, 16)}  ${r.title}`);
  } else if (cmd === 'status') {
    const runId = positionals[1];
    const s = o.at ? foldEvents(store.events(runId), undefined, Number(o.at)) : store.state(runId);
    console.log(summarize(s));
  } else if (cmd === 'verify') {
    // Event-sourcing invariant: a full replay reproduces the persisted projection.
    const ids = positionals[1] ? [positionals[1]] : store.listRuns().map((r) => r.id);
    let ok = true;
    for (const id of ids) {
      const persisted = store.state(id);
      const replayed = foldEvents(store.events(id), initialState(id));
      const same = JSON.stringify(canonicalize(replayed)) === JSON.stringify(canonicalize(persisted));
      ok &&= same;
      console.log(`${same ? '✓' : '✗'} ${id}  ${persisted.lastSeq} events  replay ${same ? '==' : '!='} persisted state`);
    }
    process.exitCode = ok ? 0 : 1;
  } else if (cmd === 'events') {
    for (const e of store.events(positionals[1], 0, 1e9, o.type?.split(','))) console.log(JSON.stringify(e));
  } else console.log(HELP);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
