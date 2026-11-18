import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventStore } from './store.ts';
import { Engine } from './engine.ts';
import { ClaudeCodeAdapter } from './adapters/claude.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { LocalAdapter } from './adapters/local.ts';
import { FreeLLMAdapter } from './adapters/free.ts';

export { EventStore } from './store.ts';
export { Engine } from './engine.ts';
export { ClaudeCodeAdapter } from './adapters/claude.ts';
export { CodexAdapter } from './adapters/codex.ts';
export { LocalAdapter } from './adapters/local.ts';
export { FreeLLMAdapter } from './adapters/free.ts';
export type { ProviderAdapter, AdapterEvent, AgentRunSpec, ProviderInfo } from './adapters/types.ts';
export { startServer } from './server.ts';

export function dataDir() {
  return process.env.SYNAPE_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'synape');
}

/** Create an engine with the built-in provider adapters. */
export async function createEngine(opts: { dir?: string; log?: (m: string) => void } = {}) {
  const dir = opts.dir ?? dataDir();
  const store = new EventStore(join(dir, 'synape.db'));
  const engine = new Engine({ store, adapters: [new ClaudeCodeAdapter(), new CodexAdapter(), new LocalAdapter(dir), FreeLLMAdapter.forDataDir(dir)], dataDir: dir, log: opts.log });
  await engine.init();
  return engine;
}
