import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalAdapter, compact, confine, parseJson } from '../src/adapters/local.ts';
import { LocalRuntime, findModel, serverArgs, type LocalConfig } from '../src/local.ts';
import { classifyCompute } from '@synape/core';
import type { AdapterEvent, AgentRunSpec } from '../src/adapters/types.ts';

/** A scripted stand-in for llama-server's OpenAI-compatible streaming API. */
type Reply = { content?: string; reasoning?: string; tool?: { name: string; args: object } };
const requests: any[] = [];
let script: (n: number, body: any) => Reply = () => ({ content: 'ok' });
const fake = createServer((req, res) => {
  if (req.url === '/health') return res.end('{"status":"ok"}');
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"local"}]}');
  if (req.url === '/props') return res.end(JSON.stringify({ model_path: '/m/Fake-35B-A3B.gguf', default_generation_settings: { n_ctx: 4096 } }));
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    requests.push(body);
    const r = script(requests.length, body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (d: object) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    if (r.reasoning) send({ choices: [{ delta: { reasoning_content: r.reasoning } }] });
    if (r.content) for (const part of r.content.match(/.{1,7}/gs) ?? []) send({ choices: [{ delta: { content: part } }] });
    if (r.tool) {
      const args = JSON.stringify(r.tool.args);
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${requests.length}`, function: { name: r.tool.name, arguments: args.slice(0, 5) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] });
    }
    send({ choices: [{ delta: {}, finish_reason: r.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
afterAll(() => fake.close());

const cfg: LocalConfig = { url, ctx: 4096, idleMinutes: 0, autostart: false, vramMarginMiB: 512, extraArgs: [], model: '/m/x.gguf', bin: '/bin/false' };
const dir = mkdtempSync(join(tmpdir(), 'synape-local-'));
const ws = join(dir, 'ws');
mkdirSync(ws);
writeFileSync(join(ws, 'notes.txt'), 'line one\nthe answer is 42\n');
const adapter = new LocalAdapter(dir, new LocalRuntime(() => cfg));

function spec(over: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return { agentId: 'agent_1', prompt: 'What is the answer in notes.txt?', model: 'local', cwd: ws, permission: 'read', extraDirs: [], timeoutMs: 30_000, signal: new AbortController().signal, scratchDir: join(dir, 'scratch'), ...over };
}
async function collect(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('local provider', () => {
  it('detects a running server', async () => {
    const info = await adapter.detect();
    expect(info.available).toBe(true);
    expect(info.billing).toBe('local');
    expect(info.version).toBe('Fake-35B-A3B.gguf');
  });

  it('runs a tool loop: tools are offered per permission, results fed back, usage accumulated', async () => {
    requests.length = 0;
    script = (n) => (n === 1 ? { reasoning: 'I should read the file', tool: { name: 'read_file', args: { path: 'notes.txt' } } } : { content: 'The answer is 42 (notes.txt:2).' });
    const ev = await collect(adapter.run(spec()));
    const final = ev.find((e) => e.kind === 'final') as Extract<AdapterEvent, { kind: 'final' }>;
    expect(final.ok).toBe(true);
    expect(final.text).toBe('The answer is 42 (notes.txt:2).');
    expect(ev.some((e) => e.kind === 'thinking' && e.text.includes('read the file'))).toBe(true);
    expect(ev.some((e) => e.kind === 'tool_start' && e.name === 'read_file')).toBe(true);
    expect(ev.find((e) => e.kind === 'tool_end')).toMatchObject({ ok: true });
    // Read permission: no write/shell tools on offer.
    const offered = requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toContain('pdf_text');
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('bash');
    // The tool result reached the model, with line numbers.
    const toolMsg = requests[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/2\tthe answer is 42/);
    // The skills preamble is in the system prompt.
    expect(requests[0].messages[0].content).toContain('PDF digest');
    const usage = [...ev].reverse().find((e) => e.kind === 'usage') as Extract<AdapterEvent, { kind: 'usage' }>;
    expect(usage.usage).toMatchObject({ inputTokens: 400, cacheReadTokens: 1600, outputTokens: 100, costBasis: 'unavailable' });
  });

  it('refuses tools above the permission level and paths outside the workspace', async () => {
    requests.length = 0;
    script = (n) => (n === 1 ? { tool: { name: 'write_file', args: { path: 'x.txt', content: 'hi' } } } : n === 2 ? { tool: { name: 'read_file', args: { path: '../../../../etc/passwd' } } } : { content: 'done' });
    const ev = await collect(adapter.run(spec()));
    const ends = ev.filter((e) => e.kind === 'tool_end') as Extract<AdapterEvent, { kind: 'tool_end' }>[];
    expect(ends[0]).toMatchObject({ ok: false });
    expect(ends[0].output).toMatch(/not available at permission "read"/);
    expect(ends[1]).toMatchObject({ ok: false });
    expect(ends[1].output).toMatch(/outside/);
  });

  it('writes at write permission and resumes a saved session', async () => {
    script = (n, body) => (body.messages.some((m: any) => m.role === 'tool') ? { content: 'wrote it' } : { tool: { name: 'write_file', args: { path: 'out/result.md', content: '# 42' } } });
    const ev = await collect(adapter.run(spec({ permission: 'write' })));
    expect(readFileSync(join(ws, 'out/result.md'), 'utf8')).toBe('# 42');
    const sid = (ev.find((e) => e.kind === 'session') as any).sessionId;
    requests.length = 0;
    script = () => ({ content: 'continued' });
    const again = await collect(adapter.run(spec({ resumeSessionId: sid, prompt: 'continue' })));
    expect((again.find((e) => e.kind === 'final') as any).text).toBe('continued');
    expect(requests[0].messages.some((m: any) => m.role === 'tool' && /wrote out\/result.md/.test(m.content))).toBe(true);
  });

  it('falls back to schema-constrained decoding for structured answers', async () => {
    requests.length = 0;
    script = (n) => (n === 1 ? { content: 'Here you go: the value is 42' } : { content: '{"value":42}' });
    const ev = await collect(adapter.run(spec({ jsonSchema: { type: 'object', properties: { value: { type: 'number' } } } })));
    expect(ev.find((e) => e.kind === 'final')).toMatchObject({ ok: true, structured: { value: 42 } });
    expect(requests[1].response_format.type).toBe('json_schema');
  });

  it('reports a missing server as a provider error (routes elsewhere, no retry blame)', async () => {
    const down = new LocalAdapter(dir, new LocalRuntime(() => ({ ...cfg, url: 'http://127.0.0.1:9' })));
    expect((await down.detect()).available).toBe(false);
    const ev = await collect(down.run(spec()));
    expect(ev.at(-1)).toMatchObject({ kind: 'final', ok: false, errorClass: 'provider' });
  });
});

describe('local helpers', () => {
  it('confines paths, including through symlinks', () => {
    symlinkSync('/etc', join(ws, 'etc-link'));
    expect(() => confine('etc-link/passwd', ws, [ws])).toThrow(/outside/);
    expect(confine('notes.txt', ws, [ws])).toMatch(/notes\.txt$/);
    expect(() => confine('new/dir/file.txt', ws, [ws], true)).not.toThrow();
    expect(() => confine('/tmp/x', ws, [ws, '/tmp'], true)).toThrow(/working directory/);
  });

  it('elides old tool output near the context limit', () => {
    const msgs: any[] = [{ role: 'system', content: 's' }, ...Array.from({ length: 6 }, (_, i) => ({ role: 'tool', content: `${i}`.repeat(1000) }))];
    compact(msgs);
    expect(msgs[1].content).toMatch(/elided/);
    expect(msgs[2].content).toMatch(/elided/);
    expect(msgs[3].content).toBe('2'.repeat(1000));
  });

  it('parses fenced or embedded JSON', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('result: {"a":2} done')).toEqual({ a: 2 });
    expect(parseJson('nope')).toBeUndefined();
  });

  it('builds tuned llama-server args, with a safe fallback without MTP', () => {
    const a = serverArgs(cfg);
    expect(a).toEqual(expect.arrayContaining(['--jinja', '-fa', 'on', '-ctk', 'q8_0', '--fit', 'on', '--spec-type', 'draft-mtp']));
    expect(a[a.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(a[a.indexOf('-c') + 1]).toBe('4096');
    expect(serverArgs(cfg, true)).not.toContain('--spec-type');
  });

  it('prefers the MoE model and ignores partial downloads and projector files', () => {
    const m = join(dir, 'models');
    mkdirSync(m);
    for (const f of ['mmproj-F16.gguf', 'small-8B.gguf', 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf.part']) writeFileSync(join(m, f), 'x');
    expect(findModel(m)).toMatch(/small-8B/);
    writeFileSync(join(m, 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'), 'x');
    expect(findModel(m)).toMatch(/Qwen3\.6-35B-A3B/);
  });

  it('shows local shell commands as computations', () => {
    expect(classifyCompute('bash', JSON.stringify({ command: 'python3 fit.py' }))).toBe('Python');
  });
});
