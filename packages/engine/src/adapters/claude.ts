import { permissionRank, type Usage } from '@synape/core';
import { clip, type AdapterEvent, type AgentRunSpec, type ProviderAdapter, type ProviderInfo } from './types.ts';
import { execText, runProcess } from './proc.ts';

/**
 * Claude Code adapter: drives the official `claude` CLI in print mode with
 * `--output-format stream-json`. Uses the user's existing CLI login; never
 * touches credentials.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  id = 'claude-code';
  private bin: string;
  constructor(bin = process.env.SYNAPE_CLAUDE_BIN ?? 'claude') {
    this.bin = bin;
  }

  async detect(): Promise<ProviderInfo> {
    const v = await execText(this.bin, ['--version']);
    if (v.code !== 0) return { id: this.id, label: 'Claude Code', available: false, reason: 'claude CLI not found on PATH', billing: 'unknown' };
    // Authentication is verified lazily by the first real call; `claude` has no
    // non-interactive status command, so we report what we can observe.
    const apiKey = !!process.env.ANTHROPIC_API_KEY;
    return {
      id: this.id,
      label: 'Claude Code',
      available: true,
      version: v.stdout.trim(),
      auth: apiKey ? 'ANTHROPIC_API_KEY (API billing)' : 'CLI login (subscription)',
      billing: apiKey ? 'api' : 'subscription',
    };
  }

  /** Tool allowlist per permission level. `--tools` is a hard boundary. */
  static toolsFor(spec: Pick<AgentRunSpec, 'permission'>): string[] {
    const r = permissionRank(spec.permission);
    const tools = ['Read', 'Glob', 'Grep'];
    if (r >= permissionRank('write')) tools.push('Edit', 'Write');
    if (r >= permissionRank('execute')) tools.push('Bash');
    if (r >= permissionRank('network')) tools.push('WebSearch', 'WebFetch');
    return tools;
  }

  args(spec: AgentRunSpec): string[] {
    const tools = ClaudeCodeAdapter.toolsFor(spec);
    const a = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      spec.model,
      // Isolation + token efficiency: no user MCP servers, hooks or plugins in workers.
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--tools',
      tools.join(','),
      '--allowedTools',
      tools.join(','),
      '--permission-mode',
      'dontAsk',
    ];
    if (spec.effort) a.push('--effort', spec.effort);
    for (const d of spec.extraDirs) a.push('--add-dir', d);
    if (spec.systemPrompt) a.push('--append-system-prompt', spec.systemPrompt);
    if (spec.jsonSchema) a.push('--json-schema', JSON.stringify(spec.jsonSchema));
    if (spec.resumeSessionId) a.push('--resume', spec.resumeSessionId);
    return a;
  }

  async *run(spec: AgentRunSpec): AsyncIterable<AdapterEvent> {
    const perMessage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
    let peak = 0;
    let finalSeen = false;
    let lastText = '';
    const stderr: string[] = [];
    const billing: Usage['costBasis'] = process.env.ANTHROPIC_API_KEY ? 'api-billed' : 'api-list-equivalent';

    const cumulative = (): Usage => {
      const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costBasis: 'unavailable', peakContextTokens: peak };
      for (const m of perMessage.values()) {
        u.inputTokens += m.input;
        u.outputTokens += m.output;
        u.cacheReadTokens += m.cacheRead;
        u.cacheWriteTokens += m.cacheWrite;
      }
      return u;
    };

    for await (const l of runProcess(this.bin, this.args(spec), { cwd: spec.cwd, stdin: spec.prompt, signal: spec.signal, timeoutMs: spec.timeoutMs })) {
      if (l.stream === 'pid') yield { kind: 'pid', pid: l.pid };
      else if (l.stream === 'error') {
        yield { kind: 'final', ok: false, text: '', error: String(l.error), errorClass: 'provider' };
        return;
      } else if (l.stream === 'stderr') {
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
        if (d.type === 'system' && d.subtype === 'init') {
          if (d.session_id) yield { kind: 'session', sessionId: d.session_id };
          yield { kind: 'system', text: `claude ${d.model} · tools: ${(d.tools ?? []).join(', ')}` };
        } else if (d.type === 'assistant') {
          const msg = d.message ?? {};
          const u = msg.usage;
          if (u && msg.id) {
            const entry = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
            perMessage.set(msg.id, entry);
            peak = Math.max(peak, entry.input + entry.cacheRead + entry.cacheWrite);
            yield { kind: 'usage', usage: cumulative() };
          }
          for (const c of msg.content ?? []) {
            if (c.type === 'text' && c.text) {
              lastText = c.text;
              yield { kind: 'text', text: c.text };
            } else if (c.type === 'thinking' && c.thinking) yield { kind: 'thinking', text: c.thinking };
            else if (c.type === 'tool_use') yield { kind: 'tool_start', id: c.id, name: c.name, input: clip(JSON.stringify(c.input ?? {}), 600) };
          }
        } else if (d.type === 'user') {
          for (const c of d.message?.content ?? []) {
            if (c.type === 'tool_result') {
              const out = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : '';
              yield { kind: 'tool_end', id: c.tool_use_id, ok: !c.is_error, output: clip(out, 800) };
            }
          }
        } else if (d.type === 'rate_limit_event') {
          const info = d.rate_limit_info ?? {};
          for (const [window, w] of Object.entries<any>(info.unifiedWindows ?? {})) {
            yield { kind: 'quota', window, utilization: w.utilization, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined, status: w.status };
          }
        } else if (d.type === 'result') {
          finalSeen = true;
          const u = d.usage ?? {};
          const mu: any = Object.values(d.modelUsage ?? {})[0] ?? {};
          const usage: Usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
            costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : undefined,
            costBasis: typeof d.total_cost_usd === 'number' ? billing : 'unavailable',
            durationMs: d.duration_ms,
            contextWindow: mu.contextWindow,
            peakContextTokens: peak,
          };
          yield { kind: 'usage', usage };
          const ok = d.subtype === 'success' && !d.is_error;
          const text = typeof d.result === 'string' && d.result ? d.result : lastText;
          const err = ok ? undefined : d.api_error_status ? `API error ${d.api_error_status}: ${text}` : `${d.subtype}: ${text || stderr.join('\n')}`;
          yield {
            kind: 'final',
            ok,
            text: d.structured_output ? lastText || text : text,
            structured: d.structured_output,
            error: err,
            errorClass: ok ? undefined : d.api_error_status || /rate|limit|auth|login|overloaded/i.test(String(err)) ? 'provider' : 'task',
          };
        }
      } else if (l.stream === 'exit') {
        if (!finalSeen) {
          const reason = l.reason ?? (l.code === 0 ? undefined : 'exit');
          yield {
            kind: 'final',
            ok: false,
            text: lastText,
            error: reason === 'timeout' ? 'timed out' : reason === 'cancelled' ? 'cancelled' : `claude exited with code ${l.code}: ${stderr.slice(-5).join(' | ')}`,
            errorClass: reason === 'timeout' ? 'timeout' : reason === 'cancelled' ? 'cancelled' : 'provider',
          };
        }
      }
    }
  }
}
