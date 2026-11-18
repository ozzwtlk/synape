import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { permissionRank, type Usage } from '@synape/core';
import { clip, type AdapterEvent, type AgentRunSpec, type ErrorClass, type ProviderAdapter, type ProviderInfo } from './types.ts';
import { execText } from './proc.ts';
import { LocalRuntime, localConfig } from '../local.ts';

/**
 * Local provider: a llama.cpp server (OpenAI-compatible chat API) driven by
 * Synape's own small agent loop, with tools that mirror the CLI agents'
 * permission levels. Meant for token-heavy, low-difficulty work (reading and
 * digesting PDFs, extraction, summaries) so cloud quota goes to the hard parts.
 */

/** Operating procedures tuned for a ~3B-active MoE: explicit method, no guessing. */
export const LOCAL_SKILLS = `You are a careful research assistant running on a local model. Work methodically with the tools; never guess file contents.

Skills:
- PDF digest: call pdf_text without pages first to learn the page count, then read in chunks of ~12 pages. Keep running notes. Cite every claim as (p. N). Copy equations, numbers and units exactly; mark anything uncertain.
- Extraction: return values with units, uncertainties and their exact source (file + line or page). If something is not in the sources, say "not found" instead of inventing it.
- Summaries: lead with the single most important result, then the key evidence, then caveats. Prefer short lists over prose.
- Code/data: read before editing; make the smallest change; re-read the file after editing to confirm it.
- Large files: use grep to locate, then read_file with offset/limit around the hits.

When you have enough evidence, stop calling tools and write the final answer in the format the task asks for.`;

interface ToolDef {
  name: string;
  description: string;
  parameters: object;
  min: 'read' | 'write' | 'execute';
}

const TOOLS: ToolDef[] = [
  { name: 'list_dir', min: 'read', description: 'List files under a directory (relative to the working directory).', parameters: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'integer', description: '1-4, default 2' } } } },
  { name: 'read_file', min: 'read', description: 'Read a text file with line numbers. Use offset/limit (lines) for large files.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'grep', min: 'read', description: 'Search file contents with a regular expression. Returns file:line:text matches.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string', description: 'e.g. *.tex' } }, required: ['pattern'] } },
  { name: 'pdf_text', min: 'read', description: 'Extract the text of a PDF. Without first_page/last_page returns the page count and the first pages.', parameters: { type: 'object', properties: { path: { type: 'string' }, first_page: { type: 'integer' }, last_page: { type: 'integer' } }, required: ['path'] } },
  { name: 'write_file', min: 'write', description: 'Create or overwrite a file inside the working directory.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', min: 'write', description: 'Replace an exact, unique string in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'bash', min: 'execute', description: 'Run a shell command (bash) in the working directory. Output is truncated.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'integer' } }, required: ['command'] } },
];

const MAX_TURNS = 80;
const TOOL_OUTPUT_CHARS = 60_000;

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export class LocalAdapter implements ProviderAdapter {
  id = 'local';
  readonly runtime: LocalRuntime;

  constructor(dataDir: string, runtime?: LocalRuntime) {
    this.runtime = runtime ?? new LocalRuntime(() => localConfig(dataDir), join(dataDir, 'local-llm.log'));
  }

  shutdown() {
    this.runtime.stop();
  }

  async detect(): Promise<ProviderInfo> {
    const c = this.runtime.config;
    const st = await this.runtime.status();
    const base = { id: this.id, label: 'Local (llama.cpp)', billing: 'local' as const };
    if (st.up) return { ...base, available: true, version: st.model, auth: `llama-server at ${c.url}${st.ctx ? ` · ctx ${st.ctx}` : ''}` };
    if (!c.autostart) return { ...base, available: false, reason: `no server at ${c.url} (autostart off)` };
    if (!c.bin) return { ...base, available: false, reason: 'llama-server not found: unpack a llama.cpp release into ~/.local/opt or set SYNAPE_LLAMA_SERVER' };
    if (!c.model) return { ...base, available: false, reason: 'no model: run scripts/get-local-model.sh' };
    return { ...base, available: true, version: c.model.split('/').pop(), auth: 'starts on demand (llama-server)' };
  }

  async *run(spec: AgentRunSpec): AsyncIterable<AdapterEvent> {
    const started = Date.now();
    const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)]);
    const why = (): ErrorClass => (spec.signal.aborted ? 'cancelled' : 'timeout');
    const release = this.runtime.hold();
    try {
      if (!(await this.runtime.status()).up) yield { kind: 'system', text: 'starting local model server (first load can take a minute)…' };
      try {
        await this.runtime.ensure(signal);
      } catch (e) {
        yield { kind: 'final', ok: false, text: '', error: `local model unavailable: ${(e as Error).message}`, errorClass: signal.aborted ? why() : 'provider' };
        return;
      }
      const cfg = this.runtime.config;
      const ctx = (await this.runtime.status()).ctx ?? cfg.ctx;

      const sessionDir = join(spec.scratchDir, 'local-sessions');
      mkdirSync(sessionDir, { recursive: true });
      let sessionId = spec.resumeSessionId;
      let messages: Msg[] = [];
      if (sessionId && /^[\w-]+$/.test(sessionId) && existsSync(join(sessionDir, `${sessionId}.json`))) {
        messages = JSON.parse(readFileSync(join(sessionDir, `${sessionId}.json`), 'utf8'));
      } else {
        sessionId = `local-${randomBytes(6).toString('hex')}`;
        messages = [{ role: 'system', content: [LOCAL_SKILLS, spec.systemPrompt].filter(Boolean).join('\n\n') }];
      }
      messages.push({ role: 'user', content: spec.prompt });
      const save = () => writeFileSync(join(sessionDir, `${sessionId}.json`), JSON.stringify(messages));
      yield { kind: 'session', sessionId };
      const tools = TOOLS.filter((t) => permissionRank(spec.permission) >= permissionRank(t.min));
      yield { kind: 'system', text: `local ${spec.model} · tools ${tools.map((t) => t.name).join(', ')} · ctx ${ctx.toLocaleString()}` };

      const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costBasis: 'unavailable', contextWindow: ctx, peakContextTokens: 0 };
      const roots = [spec.cwd, ...spec.extraDirs].map(real);
      let finalText = '';

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if ((usage.peakContextTokens ?? 0) > ctx * 0.8) compact(messages);
        let res: Completion;
        try {
          res = await complete(cfg.url, { messages, tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), max_tokens: 16_384 }, signal);
        } catch (e) {
          save();
          const crash = !(await this.runtime.status()).up && this.runtime.lastError ? ` (server: ${this.runtime.lastError})` : '';
          yield { kind: 'final', ok: false, text: finalText, error: `local model request failed: ${(e as Error).message}${crash}`, errorClass: signal.aborted ? why() : /context|too long|exceed/i.test(String(e)) ? 'task' : 'provider' };
          return;
        }
        addUsage(usage, res, started);
        yield { kind: 'usage', usage: { ...usage } };
        if (res.reasoning) yield { kind: 'thinking', text: res.reasoning };
        if (res.content) yield { kind: 'text', text: res.content };
        messages.push({ role: 'assistant', content: res.content || null, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
        if (!res.toolCalls.length) {
          finalText = res.content;
          break;
        }
        for (const call of res.toolCalls) {
          yield { kind: 'tool_start', id: call.id, name: call.function.name, input: clip(call.function.arguments, 600) };
          const out = await runTool(call, tools, spec, roots, signal);
          yield { kind: 'tool_end', id: call.id, ok: out.ok, output: clip(out.text, 800) };
          messages.push({ role: 'tool', tool_call_id: call.id, content: clip(out.text, TOOL_OUTPUT_CHARS) });
        }
        save();
        if (signal.aborted) {
          yield { kind: 'final', ok: false, text: finalText, error: why() === 'timeout' ? 'timed out' : 'cancelled', errorClass: why() };
          return;
        }
      }
      save();
      if (!finalText) {
        yield { kind: 'final', ok: false, text: '', error: `no final answer after ${MAX_TURNS} turns`, errorClass: 'task' };
        return;
      }

      let structured: unknown;
      if (spec.jsonSchema) {
        structured = parseJson(finalText);
        if (structured === undefined) {
          // Constrained decoding: the server turns the schema into a grammar.
          try {
            const r = await complete(
              cfg.url,
              {
                messages: [...messages, { role: 'user', content: 'Output only the final answer as JSON matching the required schema.' }],
                response_format: { type: 'json_schema', json_schema: { name: 'result', schema: spec.jsonSchema, strict: true } },
                chat_template_kwargs: { enable_thinking: false },
                max_tokens: 8192,
              },
              signal,
            );
            addUsage(usage, r, started);
            yield { kind: 'usage', usage: { ...usage } };
            structured = parseJson(r.content);
            if (structured !== undefined) finalText = r.content;
          } catch {}
        }
        if (structured === undefined) {
          yield { kind: 'final', ok: false, text: finalText, error: 'final answer is not valid JSON for the required schema', errorClass: 'task' };
          return;
        }
      }
      yield { kind: 'final', ok: true, text: finalText, structured };
    } finally {
      release();
    }
  }
}

// ------------------------------------------------------------------ API

interface Completion {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/**
 * Streaming chat completion over node:http, not fetch: undici's fetch gives up
 * after 5 minutes without response headers, and llama-server only answers once
 * it has processed the whole prompt (a 200k-token PDF dump takes longer).
 */
function openStream(base: string, body: Record<string, unknown>, signal: AbortSignal): Promise<IncomingMessage> {
  const u = new URL(`${base}/v1/chat/completions`);
  const payload = JSON.stringify({ model: 'local', stream: true, stream_options: { include_usage: true }, ...body });
  return new Promise((ok, fail) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, signal }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => fail(new Error(`HTTP ${res.statusCode}: ${clip(t, 400)}`)));
        res.on('error', fail);
        return;
      }
      ok(res);
    });
    req.on('error', fail);
    req.end(payload);
  });
}

async function complete(base: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Completion> {
  const res = await openStream(base, body, signal);
  const out: Completion = { content: '', reasoning: '', toolCalls: [], promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
  const calls = new Map<number, ToolCall>();
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res as AsyncIterable<Buffer>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let d: any;
      try {
        d = JSON.parse(data);
      } catch {
        continue;
      }
      if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error));
      const delta = d.choices?.[0]?.delta ?? {};
      if (delta.content) out.content += delta.content;
      if (delta.reasoning_content) out.reasoning += delta.reasoning_content;
      for (const tc of delta.tool_calls ?? []) {
        const k = tc.index ?? 0;
        const cur = calls.get(k) ?? { id: tc.id ?? `call_${k}_${randomBytes(3).toString('hex')}`, type: 'function' as const, function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(k, cur);
      }
      if (d.usage) {
        out.promptTokens = d.usage.prompt_tokens ?? 0;
        out.completionTokens = d.usage.completion_tokens ?? 0;
        out.cachedTokens = d.usage.prompt_tokens_details?.cached_tokens ?? d.timings?.cache_n ?? 0;
      }
    }
  }
  out.toolCalls = [...calls.values()].filter((c) => c.function.name);
  out.content = out.content.trim();
  return out;
}

function addUsage(u: Usage, c: Completion, started: number) {
  const cached = Math.min(c.cachedTokens, c.promptTokens);
  u.inputTokens += c.promptTokens - cached;
  u.cacheReadTokens += cached;
  u.outputTokens += c.completionTokens;
  u.peakContextTokens = Math.max(u.peakContextTokens ?? 0, c.promptTokens + c.completionTokens);
  u.durationMs = Date.now() - started;
}

/** Near the context limit: drop old tool outputs (the model can re-run a tool). */
export function compact(messages: Msg[]) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, -4)) {
    const m = messages[i];
    if (m.content && m.content.length > 400) m.content = `[earlier tool output elided to save context (${m.content.length} chars); call the tool again if you still need it]`;
  }
}

export function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  for (const cand of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    try {
      if (cand) return JSON.parse(cand);
    } catch {}
  }
  return undefined;
}

// ------------------------------------------------------------------ tools

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Resolve a tool path inside the allowed roots (symlinks included), or throw. */
export function confine(p: string | undefined, cwd: string, roots: string[], write = false): string {
  const abs = resolve(cwd, p || '.');
  // For new files, check the deepest existing parent.
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const r = join(real(probe), relative(probe, abs));
  const allowed = write ? [real(cwd)] : roots;
  if (!allowed.some((root) => r === root || r.startsWith(root + sep))) throw new Error(`path outside the ${write ? 'working directory' : 'allowed directories'}: ${p}`);
  return r;
}

async function runTool(call: ToolCall, tools: ToolDef[], spec: AgentRunSpec, roots: string[], signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
  const name = call.function.name;
  if (!tools.some((t) => t.name === name)) return { ok: false, text: `tool "${name}" is not available at permission "${spec.permission}"` };
  let a: any;
  try {
    a = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { ok: false, text: 'arguments are not valid JSON' };
  }
  try {
    switch (name) {
      case 'list_dir': {
        const root = confine(a.path, spec.cwd, roots);
        const lines: string[] = [];
        const walk = (d: string, depth: number) => {
          for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
            if (lines.length > 800 || /^(\.git|node_modules|__pycache__|\.venv)$/.test(e.name)) continue;
            const p = join(d, e.name);
            lines.push(`${relative(root, p)}${e.isDirectory() ? '/' : ''}`);
            if (e.isDirectory() && depth > 1) walk(p, depth - 1);
          }
        };
        walk(root, Math.min(4, Math.max(1, a.depth ?? 2)));
        return { ok: true, text: lines.join('\n') || '(empty)' };
      }
      case 'read_file': {
        const p = confine(a.path, spec.cwd, roots);
        if (statSync(p).size > 50 * 1024 * 1024) return { ok: false, text: 'file too large; use grep to locate content' };
        if (/\.pdf$/i.test(p)) return { ok: false, text: 'this is a PDF: use pdf_text' };
        const all = readFileSync(p, 'utf8').split('\n');
        const off = Math.max(1, a.offset ?? 1);
        const lim = Math.min(2000, Math.max(1, a.limit ?? 2000));
        const body = all.slice(off - 1, off - 1 + lim).map((l, i) => `${String(off + i).padStart(6)}\t${l}`).join('\n');
        const more = all.length > off - 1 + lim ? `\n[… ${all.length - (off - 1 + lim)} more lines; continue with offset=${off + lim}]` : '';
        return { ok: true, text: body + more };
      }
      case 'grep': {
        const p = confine(a.path, spec.cwd, roots);
        const args = ['-n', '--no-heading', '--max-columns', '300', '-m', '40', ...(a.glob ? ['-g', String(a.glob)] : []), '-e', String(a.pattern), p];
        const r = await execText('rg', args, spec.cwd, 30_000);
        if (r.code === -1) {
          const g = await execText('grep', ['-rnE', '-m', '40', String(a.pattern), p], spec.cwd, 30_000);
          return { ok: g.code === 0 || g.code === 1, text: clip(g.stdout, 30_000) || '(no matches)' };
        }
        return { ok: r.code === 0 || r.code === 1, text: clip(r.stdout.split(spec.cwd + sep).join(''), 30_000) || '(no matches)' };
      }
      case 'pdf_text': {
        const p = confine(a.path, spec.cwd, roots);
        const info = await execText('pdfinfo', [p], spec.cwd, 20_000);
        const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
        const first = Math.max(1, a.first_page ?? 1);
        const last = Math.min(pages || first + 11, a.last_page ?? first + (a.first_page ? 11 : 5));
        const r = await execText('pdftotext', ['-layout', '-f', String(first), '-l', String(last), p, '-'], spec.cwd, 60_000);
        if (r.code !== 0) return { ok: false, text: `pdftotext failed: ${r.stderr || 'is poppler installed?'}` };
        const body = r.stdout.split('\f').map((t, i) => (t.trim() ? `--- page ${first + i} ---\n${t.trimEnd()}` : '')).filter(Boolean).join('\n\n');
        return { ok: true, text: `[${pages} pages total; showing ${first}-${last}]\n${body}` };
      }
      case 'write_file': {
        const p = confine(a.path, spec.cwd, roots, true);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(a.content ?? ''));
        return { ok: true, text: `wrote ${relative(spec.cwd, p)} (${String(a.content ?? '').length} chars)` };
      }
      case 'edit_file': {
        const p = confine(a.path, spec.cwd, roots, true);
        const src = readFileSync(p, 'utf8');
        const n = src.split(String(a.old_string)).length - 1;
        if (n !== 1) return { ok: false, text: n ? `old_string occurs ${n} times; make it unique` : 'old_string not found' };
        writeFileSync(p, src.replace(String(a.old_string), () => String(a.new_string)));
        return { ok: true, text: `edited ${relative(spec.cwd, p)}` };
      }
      case 'bash':
        return await shell(String(a.command), spec.cwd, Math.min(1800, Math.max(5, a.timeout_s ?? 300)) * 1000, signal);
    }
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
  return { ok: false, text: 'unknown tool' };
}

function shell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
  return new Promise((done) => {
    const child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d: Buffer) => {
      if (out.length < 200_000) out += d;
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    };
    const t = setTimeout(kill, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => done({ ok: false, text: String(e) }));
    child.on('close', (code) => {
      clearTimeout(t);
      signal.removeEventListener('abort', kill);
      done({ ok: code === 0, text: `${clip(out, 40_000)}\n[exit ${code}]` });
    });
  });
}

