import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { findPdfs, inferOutputs, texGraphics } from './outputs.ts';
import { homedir } from 'node:os';
import type { Engine } from './engine.ts';
import { repoInfo } from './workspace.ts';
import { accessToken, cookie, hostOf, isLoopback, isPrivateAddress, machineName, sameSecret } from './net.ts';

/** Types for agent-produced files. Never text/html: those are shown as source. */
const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

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
  /** Interface to bind. Default 0.0.0.0: loopback, LAN and Tailscale. */
  host?: string;
  uiDir?: string;
  /** Token required from non-loopback clients (see net.ts). Default: persisted in the data dir. */
  accessToken?: string;
}

/**
 * Local HTTP API + Server-Sent Events.
 *
 * Security model (private network):
 *  - binds to all interfaces, but only answers loopback, private-LAN and
 *    Tailscale (100.64/10, fd7a:115c:a1e0::/48) peers; public addresses get 403;
 *  - non-loopback clients must present the persistent access token, once, via
 *    `?token=` (exchanged for an HttpOnly SameSite=Lax cookie) or a Bearer header;
 *  - loopback clients must use a localhost/IP Host header (DNS rebinding);
 *  - no CORS headers, so other origins cannot read responses;
 *  - every mutating request needs the per-process token in `x-synape-token`
 *    (cross-site form posts cannot set custom headers).
 */
const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Synape · locked</title>
<body style="font:15px system-ui;background:#05070d;color:#cfe3ff;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;padding:24px"><h2 style="margin:0 0 8px">Synape is locked</h2>
<p>Open the access link printed by <code>synape serve</code>, or run <code>synape url</code> on the host machine and open the link it prints on this device. You only need to do this once per browser.</p></div>`;

export function startServer(opts: ServerOptions) {
  const { engine } = opts;
  const host = opts.host ?? '0.0.0.0';
  const token = randomBytes(24).toString('hex');
  // Re-read so `synape url --rotate` takes effect without a restart.
  const accessNow = () => opts.accessToken ?? accessToken(engine.dataDir);
  const extraHosts = new Set((process.env.SYNAPE_ALLOWED_HOSTS ?? '').split(',').map((h) => hostOf(h.trim()).toLowerCase()).filter(Boolean));
  const me = machineName();
  /** Names a loopback client may use. Rebinding needs a DNS name, so IP literals are safe. */
  const localName = (h: string) => h === 'localhost' || h === me || h === `${me}.local` || isIP(h) !== 0 || h.endsWith('.ts.net') || extraHosts.has(h);
  const AUTH_COOKIE = 'synape_auth';

  const worktreesOf = (runId: string) => {
    const d = join(engine.dataDir, 'worktrees', runId);
    try {
      return readdirSync(d).map((x) => join(d, x));
    } catch {
      return [];
    }
  };
  const outputsCache = new Map<string, { seq: number; at: number; body: unknown }>();
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
      const peer = req.socket.remoteAddress ?? '';
      if (!isPrivateAddress(peer)) return json(res, 403, { error: 'only loopback, LAN and Tailscale clients are allowed' });
      const url = new URL(req.url ?? '/', `http://${hostHeader || 'localhost'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (isLoopback(peer)) {
        // Vite's dev proxy and local browsers: refuse DNS-rebound names.
        if (!localName(hostOf(hostHeader).toLowerCase())) return json(res, 403, { error: 'host not allowed' });
      } else {
        const access = accessNow();
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const q = url.searchParams.get('token') ?? undefined;
        if (q && sameSecret(q, access) && method === 'GET') {
          // Trade the link token for a cookie and drop it from the address bar.
          url.searchParams.delete('token');
          res.writeHead(302, {
            location: url.pathname + url.search,
            'set-cookie': `${AUTH_COOKIE}=${encodeURIComponent(access)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          });
          return res.end();
        }
        if (!sameSecret(cookie(req, AUTH_COOKIE), access) && !sameSecret(bearer, access)) {
          if (path.startsWith('/api/')) return json(res, 401, { error: 'remote access needs the Synape access token (run `synape url`)' });
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
          return res.end(LOCKED_PAGE);
        }
      }

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
      if ((r = m(/^\/api\/runs\/([\w-]+)\/tasks\/([\w-]+)\/model$/)) && method === 'POST') {
        const b = await readBody(req);
        try {
          engine.setTaskModel(r[1], r[2], b.modelId ? String(b.modelId) : undefined);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
        return json(res, 200, { ok: true });
      }
      if (path === '/api/models' && method === 'POST') {
        const b = await readBody(req);
        try {
          engine.setModelEnabled(String(b.modelId), !!b.enabled);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
        return json(res, 200, { ok: true });
      }
      if (path === '/api/provider-weight' && method === 'POST') {
        const b = await readBody(req);
        try {
          engine.setProviderWeight(String(b.provider), Number(b.weight));
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
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
      if ((r = m(/^\/api\/runs\/([\w-]+)\/outputs$/))) {
        const s = engine.state(r[1]);
        // Walking a workspace is not free: reuse for 20 s unless the run moved on.
        const hit = outputsCache.get(r[1]);
        if (hit && hit.seq === s.lastSeq && Date.now() - hit.at < 20_000) return json(res, 200, hit.body);
        const recorded: Record<string, unknown> = {};
        for (const t of Object.values(s.tasks)) if (t.outputs?.length) recorded[t.id] = t.outputs;
        const ws = s.run.workspace;
        const body = {
          recorded,
          inferred: inferOutputs(s, join(engine.dataDir, 'worktrees')),
          // The manuscript may be compiled in the user's checkout or in an agent worktree.
          pdfs: [ws, ...worktreesOf(r[1])].filter(existsSync).flatMap((d) => findPdfs(d, 30)).sort((a, b) => b.mtime - a.mtime).slice(0, 80),
          tex: existsSync(ws) ? texGraphics(ws) : { names: [], texFiles: [], mains: [], figures: [] },
        };
        outputsCache.set(r[1], { seq: s.lastSeq, at: Date.now(), body });
        return json(res, 200, body);
      }
      if ((r = m(/^\/api\/runs\/([\w-]+)\/file$/))) {
        const page = url.searchParams.get('page');
        return serveRunFile(res, r[1], url.searchParams.get('path') ?? '', url.searchParams.has('thumb') || !!page, page ? Math.max(1, Math.min(2000, Number(page) || 1)) : 1, page ? 1400 : 420);
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

  /**
   * Files an agent produced, confined to the run's workspace, its worktrees and
   * its artifact dir (symlinks resolved). Untrusted content: no HTML, nosniff,
   * and a sandbox CSP for anything but PDFs (Chrome's viewer refuses sandboxing).
   */
  function serveRunFile(res: ServerResponse, runId: string, p: string, thumb: boolean, page = 1, width = 420) {
    const s = engine.state(runId);
    if (!s.run.workspace || !p) return json(res, 404, { error: 'not found' });
    let real: string;
    try {
      real = realpathSync(resolve(p));
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    const roots = [s.run.workspace, join(engine.dataDir, 'artifacts', runId), join(engine.dataDir, 'worktrees', runId)].filter(existsSync).map((d) => realpathSync(d));
    if (!roots.some((d) => real === d || real.startsWith(d + sep))) return json(res, 403, { error: 'outside the run workspace' });
    const st = statSync(real);
    if (!st.isFile()) return json(res, 404, { error: 'not a file' });
    const ext = extname(real).toLowerCase();
    const headers: Record<string, string> = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' };
    if (thumb && ext === '.pdf') {
      // First page as PNG via poppler, cached by path+mtime.
      const dir = join(engine.dataDir, 'thumbs');
      mkdirSync(dir, { recursive: true });
      const key = createHash('sha1').update(`${real}:${st.mtimeMs}:${page}:${width}`).digest('hex');
      const png = join(dir, `${key}.png`);
      if (!existsSync(png)) {
        try {
          execFileSync('pdftoppm', ['-png', '-singlefile', '-f', String(page), '-l', String(page), '-scale-to', String(width), real, join(dir, key)], { timeout: 20000, stdio: 'ignore' });
        } catch {
          return json(res, 404, { error: 'no such page, or pdftoppm unavailable' });
        }
      }
      res.writeHead(200, { ...headers, 'content-type': 'image/png' });
      return res.end(readFileSync(png));
    }
    if (st.size > 60 * 1024 * 1024) return json(res, 413, { error: 'file too large to preview' });
    const type = FILE_MIME[ext] ?? 'text/plain; charset=utf-8';
    if (ext !== '.pdf') headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
    res.writeHead(200, { ...headers, 'content-type': type });
    res.end(readFileSync(real));
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
