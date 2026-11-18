import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Engine } from '../src/engine.ts';
import { EventStore } from '../src/store.ts';
import { startServer } from '../src/server.ts';
import { accessToken, hostOf, isPrivateAddress } from '../src/net.ts';
import { networkInterfaces } from 'node:os';
import { ScriptedAdapter, isPlan, plannedTask } from './fakes.ts';

const dir = mkdtempSync(join(tmpdir(), 'synape-srv-'));
const store = new EventStore(join(dir, 'db.sqlite'));
const adapter = new ScriptedAdapter('a', (spec) => (isPlan(spec) ? { structured: { summary: 's', reply: 'r', tasks: [plannedTask('x')] } } : { text: '## Summary\nok' }));
const engine = new Engine({
  store,
  adapters: [adapter],
  dataDir: dir,
  models: [{ id: 'a:m', provider: 'a', model: 'm', label: 'm', billing: 'subscription', tier: 2, contextWindow: 1e5, skill: { planning: 0.9, analysis: 0.9, writing: 0.9 }, ruPer1kTokens: 1, latencyFactor: 1 }],
});
await engine.init();
const port = 17000 + Math.floor(Math.random() * 2000);
const srv = startServer({ engine, port });
afterAll(() => srv.close());

function call(path: string, opts: { method?: string; host?: string; via?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, any> }>((ok, fail) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const r = request({ host: opts.via ?? '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => ok({ status: res.statusCode!, body: b, headers: res.headers }));
    });
    r.on('error', fail);
    if (data) r.write(data);
    r.end();
  });
}

// A non-loopback address of this machine, to act as a "remote" LAN client.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && !a.internal && a.family === 'IPv4' && isPrivateAddress(a.address))?.address;

describe('network access', () => {
  it('classifies private, Tailscale and public peers', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.26', '10.1.2.3', '172.20.0.1', '100.101.102.103', 'fd7a:115c:a1e0::1234', 'fe80::1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', '::ffff:1.1.1.1']) expect(isPrivateAddress(a), a).toBe(false);
    expect(hostOf('[::1]:7420')).toBe('::1');
    expect(hostOf('box.tail1234.ts.net:7420')).toBe('box.tail1234.ts.net');
  });

  it('lets loopback clients use IP or tailnet host names', async () => {
    expect((await call('/api/runs', { host: `192.168.1.20:${port}` })).status).toBe(200);
    expect((await call('/api/runs', { host: `box.tail1234.ts.net:${port}` })).status).toBe(200);
  });

  it.skipIf(!lanIp)('requires the access token from LAN clients and trades it for a cookie', async () => {
    const host = `${lanIp}:${port}`;
    expect((await call('/api/runs', { via: lanIp, host })).status).toBe(401);
    expect((await call('/', { via: lanIp, host })).body).toContain('Synape is locked');
    expect((await call('/?token=wrong', { via: lanIp, host })).status).toBe(401);
    const token = accessToken(dir);
    const r = await call(`/?token=${token}`, { via: lanIp, host });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    const set = String(r.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/);
    const cookie = set.split(';')[0];
    expect((await call('/api/runs', { via: lanIp, host, headers: { cookie } })).status).toBe(200);
    expect((await call('/api/runs', { via: lanIp, host, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('server security', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    expect((await call('/api/runs', { host: 'evil.example:80' })).status).toBe(403);
  });

  it('requires the token and JSON for mutations', async () => {
    const body = { objective: 'x', workspace: dir };
    expect((await call('/api/runs', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    const { token } = JSON.parse((await call('/api/bootstrap')).body);
    expect((await call('/api/runs', { method: 'POST', body, headers: { 'x-synape-token': token, 'content-type': 'text/plain' } })).status).toBe(415);
    const ok = await call('/api/runs', { method: 'POST', body, headers: { 'x-synape-token': token, 'content-type': 'application/json' } });
    expect(ok.status).toBe(201);
  });

  it('does not emit CORS headers and confines the directory browser to $HOME', async () => {
    const r = await call('/api/fs?path=/etc');
    expect(r.status).toBe(403);
  });

  it('streams backlog then live events over SSE without gaps', async () => {
    const { token } = JSON.parse((await call('/api/bootstrap')).body);
    const { runId } = JSON.parse((await call('/api/runs', { method: 'POST', body: { objective: 'sse', workspace: dir }, headers: { 'x-synape-token': token, 'content-type': 'application/json' } })).body);
    const seqs: number[] = await new Promise((ok) => {
      const got: number[] = [];
      const r = request({ host: '127.0.0.1', port, path: `/api/runs/${runId}/stream?after=0`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.on('data', (c) => {
          for (const m of String(c).matchAll(/^id: (\d+)$/gm)) got.push(Number(m[1]));
          if (engine.state(runId).run.status === 'completed' && got.at(-1) === engine.state(runId).lastSeq) {
            r.destroy();
            ok(got);
          }
        });
      });
      r.end();
    });
    expect(seqs[0]).toBe(1);
    seqs.forEach((s, i) => expect(s).toBe(i + 1));
  });
});

import { isUsageLimit } from '../src/adapters/types.ts';
describe('usage-limit classification', () => {
  it('waits on limits but routes around missing model access', () => {
    expect(isUsageLimit("API error 429: You've hit your 5-hour limit · resets 9:10pm")).toBe(true);
    expect(isUsageLimit('You’ve hit your usage limit. Upgrade to Pro or try again at 11:00 PM.')).toBe(true);
    expect(isUsageLimit('API error 429: Fable 5.2 requires usage credits. Switch to another model')).toBe(false);
  });
});
