import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Engine } from './engine.ts';
import { repoInfo } from './workspace.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  engine: Engine;
  port: number;
  host?: string;
  uiDir?: string;
}

/**
 * Local HTTP API + Server-Sent Events.
 *
 * Security model (local-first):
 *  - binds to 127.0.0.1 only by default;
 *  - rejects requests whose Host header is not localhost (DNS rebinding);
 *  - no CORS headers, so other origins cannot read responses;
 *  - every mutating request needs the per-process token in `x-synape-token`
 *    (cross-site form posts cannot set custom headers).
 */
export function startServer(opts: ServerOptions) {
  const { engine } = opts;
  const host = opts.host ?? '127.0.0.1';
  const token = randomBytes(24).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  // Vite dev server proxies with its own host.
  for (const p of (process.env.SYNAPE_ALLOWED_HOSTS ?? 'localhost:5173,127.0.0.1:5173').split(',')) allowedHosts.add(p);

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<any>((ok, fail) => {
      let d = '';
      req.on('data', (c) => {
        d += c;
        if (d.length > 2_000_000) {
          fail(new Error('body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          ok(d ? JSON.parse(d) : {});
        } catch (e) {
          fail(e);
        }
      });
    });

  const server = createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host ?? '';
      if (!allowedHosts.has(hostHeader)) return json(res, 403, { error: 'host not allowed' });
      const url = new URL(req.url ?? '/', `http://${hostHeader}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (!path.startsWith('/api/')) return serveStatic(res, path);
      if (method !== 'GET') {
        if (req.headers['x-synape-token'] !== token) return json(res, 401, { error: 'missing or invalid x-synape-token' });
        if (!(req.headers['content-type'] ?? '').includes('application/json')) return json(res, 415, { error: 'application/json required' });
      }
      const m = (re: RegExp) => path.match(re);
      let r: RegExpMatchArray | null;

      if (path === '/api/bootstrap') return json(res, 200, { token, home: homedir(), cwd: process.cwd() });
      if (path === '/api/providers') {
        const quotas: Record<string, unknown> = {};
        for (const run of engine.store.listRuns().slice(0, 10)) for (const [k, q] of Object.entries(engine.state(run.id).quotas)) if (!quotas[k] || (quotas[k] as any).observedAt < q.observedAt) quotas[k] = q;
        return json(res, 200, { providers: [...engine.providers.values()], models: engine.models, quotas, perf: engine.store.perfTable() });
      }
      if (path === '/api/providers/refresh' && method === 'POST') return json(res, 200, await engine.detectProviders());
      if (path === '/api/runs' && method === 'GET') return json(res, 200, engine.store.listRuns());
      if (path === '/api/runs' && method === 'POST') {
        const b = await readBody(req);
        if (!b.objective || typeof b.objective !== 'string') return json(res, 400, { error: 'objective required' });
        const ws = resolve(String(b.workspace || process.cwd()));
        if (!existsSync(ws) || !statSync(ws).isDirectory()) return json(res, 400, { error: `workspace ${ws} is not a directory` });
        const extraDirs = (b.config?.extraDirs ?? []).map((d: string) => resolve(d)).filter((d: string) => existsSync(d));
        const runId = engine.createRun({ objective: b.objective, workspace: ws, title: b.title, config: { ...b.config, extraDirs } });
        return json(res, 201, { runId });
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/state$/))) return json(res, 200, engine.state(r[1]));
      if ((r = m(/^\/api\/runs\/([\w-]+)\/events$/))) {
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(res, 200, engine.store.events(r[1], after, Number(url.searchParams.get('limit') ?? 1_000_000)));
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/stream$/))) return stream(req, res, r[1], Number(url.searchParams.get('after') ?? 0));
      if ((r = m(/^\/api\/runs\/([\w-]+)\/agents\/([\w-]+)\/log$/))) return json(res, 200, engine.store.agentLog(r[1], r[2]));
      if ((r = m(/^\/api\/runs\/([\w-]+)\/artifacts\/([\w-]+)$/))) {
        const art = engine.state(r[1]).artifacts[r[2]];
        if (!art || !existsSync(art.path)) return json(res, 404, { error: 'artifact not found' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(readFileSync(art.path));
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/messages$/)) && method === 'POST') {
        const b = await readBody(req);
        engine.postMessage(r[1], String(b.text ?? ''), b.agentId || undefined);
        return json(res, 202, { ok: true });
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/control$/)) && method === 'POST') {
        const b = await readBody(req);
        if (b.action === 'pause') engine.pause(r[1]);
        else if (b.action === 'resume') engine.resume(r[1]);
        else if (b.action === 'cancel') engine.cancelRun(r[1]);
        else return json(res, 400, { error: 'unknown action' });
        return json(res, 200, { ok: true });
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/tasks\/([\w-]+)\/(cancel|retry)$/)) && method === 'POST') {
        if (r[3] === 'cancel') engine.cancelTask(r[1], r[2]);
        else engine.retryTask(r[1], r[2]);
        return json(res, 200, { ok: true });
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/approvals\/([\w-]+)$/)) && method === 'POST') {
        const b = await readBody(req);
        engine.resolveApproval(r[1], r[2], !!b.approved, b.note);
        return json(res, 200, { ok: true });
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/git$/)) && method === 'POST') {
        const b = await readBody(req);
        if (!['git-commit', 'git-push', 'pull-request'].includes(b.kind)) return json(res, 400, { error: 'bad kind' });
        await engine.requestGitAction(r[1], b.kind);
        return json(res, 202, { ok: true });
      }
      if (path === '/api/git') {
        const p = resolve(url.searchParams.get('path') ?? process.cwd());
        return json(res, 200, await repoInfo(p, true));
      }
      if (path === '/api/fs') {
        // Directory picker for workspace selection; confined to $HOME.
        const home = homedir();
        const p = resolve(url.searchParams.get('path') ?? home);
        if (p !== home && !p.startsWith(home + sep)) return json(res, 403, { error: 'outside home directory' });
        const entries = readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort()
          .slice(0, 500);
        return json(res, 200, { path: p, parent: p === home ? null : resolve(p, '..'), entries });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });

  function stream(req: IncomingMessage, res: ServerResponse, runId: string, after: number) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let last = after;
    const send = (e: { seq: number }) => {
      if (e.seq <= last) return;
      last = e.seq;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    // Subscribe first, then flush backlog: no gap between the two.
    const pending: any[] = [];
    let flushing = true;
    const unsub = engine.store.subscribe(runId, (e) => (flushing ? pending.push(e) : send(e)));
    for (const e of engine.store.events(runId, after)) send(e);
    for (const e of pending) send(e);
    flushing = false;
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  }

  function serveStatic(res: ServerResponse, path: string) {
    const dir = opts.uiDir;
    if (!dir || !existsSync(dir)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Synape API is running. UI not built: run `pnpm build` (or `pnpm dev` and open http://localhost:5173).');
    }
    let file = resolve(join(dir, decodeURIComponent(path)));
    if (!file.startsWith(resolve(dir))) {
      res.writeHead(403);
      return res.end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
    res.end(readFileSync(file));
  }

  server.listen(opts.port, host);
  // SSE streams are long-lived: drop open connections so shutdown never hangs on a browser tab.
  return {
    server,
    token,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
