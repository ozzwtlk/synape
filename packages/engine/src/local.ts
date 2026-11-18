import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Local model runtime: a llama.cpp `llama-server` (OpenAI-compatible API)
 * that Synape starts on demand, tunes for the GPU, and stops when idle so
 * the VRAM is free again for everything else.
 *
 * Defaults target one 16 GB consumer GPU + 32 GB RAM running a hybrid-
 * attention MoE (Qwen3.6-35B-A3B): `--fit` keeps attention, shared experts
 * and the KV cache on the GPU and streams the remaining routed experts from
 * RAM; q8 KV and the model's own MTP head (speculative decoding) keep long
 * contexts cheap. Every setting can be overridden.
 */
export interface LocalConfig {
  /** OpenAI-compatible base URL (no trailing /v1). */
  url: string;
  bin?: string;
  model?: string;
  ctx: number;
  /** Stop a server Synape started after this many idle minutes (0 = never). */
  idleMinutes: number;
  /** Start llama-server automatically when a local task is routed. */
  autostart: boolean;
  /** MiB of VRAM `--fit` leaves free for the desktop/compositor. */
  vramMarginMiB: number;
  extraArgs: string[];
}

const HOME = homedir();
/**
 * 160k, not the model's native 262k: on an RX 6800 XT (Vulkan) a prompt past
 * ~200k tokens makes single GPU jobs outlast amdgpu's default compute timeout
 * (ring timeout → vk DeviceLost), measured at 199k and 207k. Raise
 * amdgpu.lockup_timeout to use the full window.
 */
export const DEFAULT_CTX = 163_840;

export const MODELS_DIR = process.env.SYNAPE_MODELS_DIR ?? join(HOME, '.local', 'share', 'llm', 'models');

/** Newest llama.cpp release unpacked under ~/.local/opt, else PATH. */
export function findLlamaServer(): string | undefined {
  if (process.env.SYNAPE_LLAMA_SERVER) return process.env.SYNAPE_LLAMA_SERVER;
  const opt = join(HOME, '.local', 'opt');
  const cands: string[] = [join(opt, 'llama.cpp', 'llama-server')];
  try {
    for (const d of readdirSync(opt).filter((d) => d.startsWith('llama.cpp')).sort().reverse()) {
      cands.push(join(opt, d, 'llama-server'));
      try {
        for (const s of readdirSync(join(opt, d))) cands.push(join(opt, d, s, 'llama-server'));
      } catch {}
    }
  } catch {}
  for (const c of cands) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, 'llama-server'))) return join(dir, 'llama-server');
  return undefined;
}

/** Preferred model in MODELS_DIR (downloads in progress are *.gguf.part), Qwen3.6-35B-A3B first. */
export function findModel(dir = MODELS_DIR): string | undefined {
  if (process.env.SYNAPE_LOCAL_MODEL) return process.env.SYNAPE_LOCAL_MODEL;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.gguf') && !/^(mmproj|mtp-)|imatrix/i.test(f));
  } catch {
    return undefined;
  }
  const score = (f: string) => (/qwen3\.6-35b-a3b/i.test(f) ? 3 : /a3b|a4b|moe/i.test(f) ? 2 : 1);
  files.sort((a, b) => score(b) - score(a) || statSync(join(dir, b)).size - statSync(join(dir, a)).size);
  return files[0] ? join(dir, files[0]) : undefined;
}

export function localConfig(dataDir: string): LocalConfig {
  let s: Partial<LocalConfig> = {};
  try {
    s = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).local ?? {};
  } catch {}
  const env = process.env;
  return {
    url: (env.SYNAPE_LOCAL_URL ?? s.url ?? 'http://127.0.0.1:8091').replace(/\/+$/, '').replace(/\/v1$/, ''),
    bin: s.bin ?? findLlamaServer(),
    model: s.model ?? findModel(),
    ctx: Number(env.SYNAPE_LOCAL_CTX ?? s.ctx ?? DEFAULT_CTX),
    idleMinutes: Number(env.SYNAPE_LOCAL_IDLE_MIN ?? s.idleMinutes ?? 20),
    autostart: (env.SYNAPE_LOCAL_AUTOSTART ?? String(s.autostart ?? true)) !== 'false',
    vramMarginMiB: Number(s.vramMarginMiB ?? 768),
    extraArgs: s.extraArgs ?? [],
  };
}

/**
 * llama-server arguments. `safe` drops the speculative-decoding flags, used
 * when the tuned launch fails (e.g. a GGUF without an MTP head).
 */
export function serverArgs(c: LocalConfig, safe = false): string[] {
  const u = new URL(c.url);
  const a = [
    '-m', c.model!,
    '--host', u.hostname, // loopback by default: never exposed on the LAN
    '--port', u.port || '8091',
    '--alias', 'local',
    '--jinja', // the model's own chat template, incl. tool calling
    '--reasoning-format', 'deepseek', // thinking → reasoning_content, not the answer
    '-c', String(c.ctx),
    '-np', '1', // one slot owns the whole context window
    '-fa', 'on',
    '-ctk', 'q8_0', '-ctv', 'q8_0', // half the KV memory, ~lossless
    '--fit', 'on', '--fit-target', String(c.vramMarginMiB), '--fit-ctx', String(c.ctx),
    // Prompt batch: 2048 is ~1.5x faster on long PDFs than 1024. Larger batches make a
    // single GPU job at 100k+ context outlast amdgpu's compute timeout (device lost).
    '-b', '2048', '-ub', '2048',
    '--no-mmproj', // text only: the vision tower would cost ~1 GB VRAM
    // Qwen's recommended sampling for thinking mode.
    '--temp', '0.6', '--top-p', '0.95', '--top-k', '20', '--min-p', '0',
  ];
  if (!safe) a.push('--spec-type', 'draft-mtp');
  return [...a, ...c.extraArgs];
}

export interface LocalStatus {
  up: boolean;
  managed: boolean;
  model?: string;
  ctx?: number;
  error?: string;
}

async function getJson(url: string, timeoutMs = 1500): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/** Starts, health-checks and idles out one llama-server. */
export class LocalRuntime {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private active = 0;
  private idleTimer?: NodeJS.Timeout;
  lastError?: string;

  private cfg: () => LocalConfig;
  private logFile?: string;

  constructor(cfg: () => LocalConfig, logFile?: string) {
    this.cfg = cfg;
    this.logFile = logFile;
  }

  get config() {
    return this.cfg();
  }

  async status(): Promise<LocalStatus> {
    const c = this.cfg();
    try {
      const h = await fetch(`${c.url}/health`, { signal: AbortSignal.timeout(1500) });
      if (!h.ok) return { up: false, managed: !!this.child, error: h.status === 503 ? 'loading model' : `health ${h.status}` };
      const props = await getJson(`${c.url}/props`).catch(() => ({}));
      const models = await getJson(`${c.url}/v1/models`).catch(() => ({}));
      const model = props?.model_path ? basename(props.model_path) : models?.data?.[0]?.id;
      return { up: true, managed: !!this.child, model, ctx: props?.default_generation_settings?.n_ctx ?? props?.n_ctx };
    } catch (e) {
      return { up: false, managed: !!this.child, error: this.lastError ?? (e as Error).message };
    }
  }

  /** Make sure a server answers; start one if allowed. */
  async ensure(signal?: AbortSignal): Promise<void> {
    if ((await this.status()).up) return;
    const c = this.cfg();
    if (!c.autostart) throw new Error(`local model server not reachable at ${c.url} (autostart disabled)`);
    if (!c.bin) throw new Error('llama-server not found (see docs: local models)');
    if (!c.model) throw new Error(`no .gguf model in ${MODELS_DIR}`);
    this.starting ??= this.launch(c, signal).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(c: LocalConfig, signal?: AbortSignal) {
    for (const safe of [false, true]) {
      const ok = await this.spawnOnce(c, serverArgs(c, safe), signal);
      if (ok) return;
      if (signal?.aborted) throw new Error('cancelled');
    }
    throw new Error(`llama-server failed to start: ${this.lastError ?? 'unknown error'}${this.logFile ? ` (log: ${this.logFile})` : ''}`);
  }

  private spawnOnce(c: LocalConfig, args: string[], signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const log = this.logFile ? createWriteStream(this.logFile, { flags: 'a' }) : undefined;
      log?.write(`\n=== ${new Date().toISOString()} ${c.bin} ${args.join(' ')}\n`);
      const child = spawn(c.bin!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      // Never leave a 20 GB model resident after Synape exits.
      const reap = () => child.exitCode === null && child.kill('SIGTERM');
      process.once('exit', reap);
      child.once('exit', () => process.off('exit', reap));
      let tail = '';
      const onData = (d: Buffer) => {
        log?.write(d);
        tail = (tail + d.toString()).slice(-4000);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        resolve(ok);
      };
      child.on('error', (e) => {
        this.lastError = String(e);
        done(false);
      });
      child.on('exit', (code, sig) => {
        const wasCurrent = this.child === child;
        if (wasCurrent) this.child = undefined;
        log?.end();
        if (/DeviceLost/i.test(tail)) this.lastError = 'GPU job timed out (vk DeviceLost): prompt too long for the batch size; lower -ub in settings.local.extraArgs or raise amdgpu.lockup_timeout';
        else if (!settled || (wasCurrent && sig !== 'SIGTERM')) this.lastError = `exited with ${code ?? sig}: ${tail.split('\n').filter((l) => /error|fail|invalid|unknown/i.test(l)).slice(-3).join(' | ') || tail.slice(-300)}`;
        if (!settled) done(false);
      });
      const t0 = Date.now();
      const poll = setInterval(async () => {
        if (signal?.aborted) {
          this.stop();
          return done(false);
        }
        // Loading 20+ GB from disk and fitting tensors takes a while.
        if (Date.now() - t0 > 10 * 60_000) {
          this.lastError = 'timed out waiting for the model to load';
          this.stop();
          return done(false);
        }
        if ((await this.status()).up) {
          this.lastError = undefined;
          done(true);
        }
      }, 1000);
    });
  }

  /** Mark a request in flight (keeps the idle timer from stopping the server). */
  hold(): () => void {
    this.active++;
    clearTimeout(this.idleTimer);
    return () => {
      this.active--;
      if (this.active > 0 || !this.child) return;
      const min = this.cfg().idleMinutes;
      if (min > 0) {
        this.idleTimer = setTimeout(() => this.active === 0 && this.stop(), min * 60_000);
        this.idleTimer.unref();
      }
    };
  }

  stop() {
    clearTimeout(this.idleTimer);
    const ch = this.child;
    this.child = undefined;
    if (ch && ch.exitCode === null) {
      ch.kill('SIGTERM');
      setTimeout(() => ch.exitCode === null && ch.kill('SIGKILL'), 5000).unref();
    }
  }
}

/** `synape local [serve|status|args]` */
export async function localCommand(sub: string, dataDir: string) {
  const rt = new LocalRuntime(() => localConfig(dataDir));
  const c = rt.config;
  if (sub === 'args') return console.log([c.bin ?? 'llama-server', ...serverArgs({ ...c, model: c.model ?? '<model.gguf>' })].join(' '));
  if (sub === 'status') {
    const st = await rt.status();
    console.log(`  server   ${c.url}  ${st.up ? `✓ up · ${st.model ?? '?'} · ctx ${st.ctx ?? '?'}` : `✗ down (${st.error})`}`);
    console.log(`  binary   ${c.bin ?? '✗ not found (set SYNAPE_LLAMA_SERVER)'}`);
    console.log(`  model    ${c.model ?? `✗ none in ${MODELS_DIR}`}`);
    console.log(`  context  ${c.ctx.toLocaleString()} tokens · autostart ${c.autostart ? 'on' : 'off'} · idle stop ${c.idleMinutes || '∞'} min`);
    return;
  }
  if (sub === 'serve') {
    if (!c.bin || !c.model) return console.error('llama-server binary or model missing; run `synape local status`.');
    const args = serverArgs(c);
    console.log(`$ ${c.bin} ${args.join(' ')}\n`);
    const child = spawn(c.bin, args, { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  console.error(`unknown: synape local ${sub} (use serve | status | args)`);
}
