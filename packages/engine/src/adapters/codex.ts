import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { permissionRank, type Usage } from '@synape/core';
import { clip, isUsageLimit, type AdapterEvent, type AgentRunSpec, type ProviderAdapter, type ProviderInfo } from './types.ts';
import { execText, runProcess } from './proc.ts';

/**
 * Codex adapter: drives the official `codex exec --json` CLI. Uses the
 * user's existing `codex login`. Codex reports token counts but no cost or
 * quota, so cost is reported as unavailable rather than invented.
 */
export class CodexAdapter implements ProviderAdapter {
  id = 'codex';
  private bin: string;
  constructor(bin = process.env.SYNAPE_CODEX_BIN ?? 'codex') {
    this.bin = bin;
  }

  async detect(): Promise<ProviderInfo> {
    const v = await execText(this.bin, ['--version']);
    if (v.code !== 0) return { id: this.id, label: 'Codex', available: false, reason: 'codex CLI not found on PATH', billing: 'unknown' };
    const s = await execText(this.bin, ['login', 'status']);
    const out = (s.stdout + s.stderr).trim();
    const loggedIn = s.code === 0 && /logged in/i.test(out);
    return {
      id: this.id,
      label: 'Codex',
      available: loggedIn,
      reason: loggedIn ? undefined : 'codex is installed but not logged in (run `codex login`)',
      version: v.stdout.trim(),
      auth: out.split('\n')[0],
      billing: /api key/i.test(out) ? 'api' : 'subscription',
    };
  }

  static sandboxFor(spec: Pick<AgentRunSpec, 'permission'>) {
    const r = permissionRank(spec.permission);
    return {
      mode: r >= permissionRank('write') ? 'workspace-write' : 'read-only',
      network: r >= permissionRank('network'),
    };
  }

  args(spec: AgentRunSpec): string[] {
    const sb = CodexAdapter.sandboxFor(spec);
    const opts = ['--json', '--skip-git-repo-check', '-m', spec.model, '-c', `sandbox_mode="${sb.mode}"`, '-c', 'approval_policy="never"'];
    if (sb.mode === 'workspace-write') {
      // Writable roots = the working directory only: not /tmp or $TMPDIR, so an
      // agent cannot write into other checkouts that happen to live there.
      opts.push('-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true');
    }
    if (sb.network) opts.push('-c', 'sandbox_workspace_write.network_access=true');
    if (spec.effort) opts.push('-c', `model_reasoning_effort="${spec.effort}"`);
    if (spec.jsonSchema) {
      mkdirSync(spec.scratchDir, { recursive: true });
      const p = join(spec.scratchDir, `${spec.agentId}.schema.json`);
      writeFileSync(p, JSON.stringify(spec.jsonSchema));
      opts.push('--output-schema', p);
    }
    opts.push('-o', this.lastMessagePath(spec));
    if (spec.resumeSessionId) return ['exec', 'resume', spec.resumeSessionId, ...opts, '-'];
    if (sb.mode === 'workspace-write') for (const d of spec.extraDirs) opts.push('--add-dir', d);
    return ['exec', ...opts, '-'];
  }

  private lastMessagePath(spec: AgentRunSpec) {
    mkdirSync(spec.scratchDir, { recursive: true });
    return join(spec.scratchDir, `${spec.agentId}.last.txt`);
  }

  async *run(spec: AgentRunSpec): AsyncIterable<AdapterEvent> {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costBasis: 'unavailable' };
    let lastText = '';
    let failure: string | undefined;
    let completed = false;
    const stderr: string[] = [];
    const prompt = spec.systemPrompt ? `${spec.systemPrompt}\n\n${spec.prompt}` : spec.prompt;
    const started = Date.now();

    for await (const l of runProcess(this.bin, this.args(spec), { cwd: spec.cwd, stdin: prompt, signal: spec.signal, timeoutMs: spec.timeoutMs })) {
      if (l.stream === 'pid') yield { kind: 'pid', pid: l.pid };
      else if (l.stream === 'error') {
        yield { kind: 'final', ok: false, text: '', error: String(l.error), errorClass: 'provider' };
        return;
      } else if (l.stream === 'stderr') {
        if (/^Reading (additional )?(prompt|input) from stdin/.test(l.line)) continue;
        stderr.push(l.line);
        if (stderr.length > 50) stderr.shift();
        yield { kind: 'stderr', text: l.line };
      } else if (l.stream === 'stdout') {
        let d: any;
        try {
          d = JSON.parse(l.line);
        } catch {
          yield { kind: 'system', text: clip(l.line, 400) };
          continue;
        }
        const it = d.item;
        switch (d.type) {
          case 'thread.started':
            yield { kind: 'session', sessionId: d.thread_id };
            yield { kind: 'system', text: `codex ${spec.model}${spec.effort ? ` (${spec.effort})` : ''} · sandbox ${CodexAdapter.sandboxFor(spec).mode}` };
            break;
          case 'item.started':
            if (it?.type === 'command_execution') yield { kind: 'tool_start', id: it.id, name: 'shell', input: clip(it.command ?? '', 600) };
            else if (it?.type === 'mcp_tool_call') yield { kind: 'tool_start', id: it.id, name: `${it.server}.${it.tool}`, input: clip(JSON.stringify(it.arguments ?? {}), 600) };
            else if (it?.type === 'web_search') yield { kind: 'tool_start', id: it.id, name: 'web_search', input: clip(it.query ?? '', 300) };
            break;
          case 'item.completed':
            if (!it) break;
            if (it.type === 'agent_message') {
              lastText = it.text ?? '';
              yield { kind: 'text', text: lastText };
            } else if (it.type === 'reasoning') yield { kind: 'thinking', text: it.text ?? '' };
            else if (it.type === 'command_execution') yield { kind: 'tool_end', id: it.id, ok: it.exit_code === 0, output: clip(it.aggregated_output ?? '', 800) };
            else if (it.type === 'file_change') {
              const files = (it.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join(', ');
              yield { kind: 'tool_start', id: it.id, name: 'apply_patch', input: clip(files, 600) };
              yield { kind: 'tool_end', id: it.id, ok: it.status !== 'failed', output: it.status ?? '' };
            } else if (it.type === 'mcp_tool_call' || it.type === 'web_search') yield { kind: 'tool_end', id: it.id, ok: it.status !== 'failed', output: clip(JSON.stringify(it.result ?? it.status ?? ''), 800) };
            else if (it.type === 'error') yield { kind: 'stderr', text: it.message ?? 'error' };
            break;
          case 'turn.completed': {
            completed = true;
            const u = d.usage ?? {};
            const cached = u.cached_input_tokens ?? 0;
            // OpenAI semantics: input_tokens includes cached input.
            usage.inputTokens += Math.max(0, (u.input_tokens ?? 0) - cached);
            usage.cacheReadTokens += cached;
            usage.cacheWriteTokens += u.cache_write_input_tokens ?? 0;
            usage.outputTokens += u.output_tokens ?? 0;
            usage.reasoningTokens += u.reasoning_output_tokens ?? 0;
            usage.durationMs = Date.now() - started;
            yield { kind: 'usage', usage: { ...usage } };
            break;
          }
          case 'turn.failed':
            failure = d.error?.message ?? 'turn failed';
            break;
          case 'error':
            failure = d.message ?? 'error';
            break;
        }
      } else if (l.stream === 'exit') {
        const lm = this.lastMessagePath(spec);
        const finalText = existsSync(lm) ? readFileSync(lm, 'utf8') : lastText;
        if (l.reason) {
          yield { kind: 'final', ok: false, text: finalText, error: l.reason === 'timeout' ? 'timed out' : 'cancelled', errorClass: l.reason };
          return;
        }
        const ok = completed && !failure && l.code === 0;
        let structured: unknown;
        if (ok && spec.jsonSchema) {
          try {
            structured = JSON.parse(finalText);
          } catch {}
        }
        const err = ok ? undefined : failure ?? `codex exited with code ${l.code}: ${stderr.slice(-5).join(' | ')}`;
        yield {
          kind: 'final',
          ok,
          text: finalText,
          structured,
          error: err,
          errorClass: ok ? undefined : isUsageLimit(String(err)) ? 'quota' : /rate|limit|auth|login|usage|quota|401|429/i.test(String(err)) || !completed ? 'provider' : 'task',
        };
      }
    }
  }
}
