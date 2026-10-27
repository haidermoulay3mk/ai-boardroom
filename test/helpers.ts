import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCast } from '../src/advisors.ts';
import { config } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { Hub } from '../src/hub.ts';
import { DemoProvider } from '../src/providers/demo.ts';
import type { Provider } from '../src/providers/types.ts';
import { Store } from '../src/store.ts';
import type { Session } from '../src/types.ts';

const dirs: string[] = [];
const stores: Store[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boardroom-test-'));
  dirs.push(dir);
  return dir;
}

/** Let pending saves land before deleting the temp folders they write into. */
export async function cleanup(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50));
  await Promise.all(stores.splice(0).map(s => s.flush()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function setup(provider: Provider = new DemoProvider(0)) {
  const dir = tempDir();
  const store = new Store(dir);
  stores.push(store);
  const hub = new Hub();
  const engine = new Engine({ store, hub, cast: loadCast(config.advisorsDir), providers: { 'claude-code': provider, demo: provider } });
  return { dir, store, hub, engine };
}

export async function waitFor(read: () => Session | undefined, predicate: (s: Session) => boolean, ms = 8000): Promise<Session> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = read();
    if (s && predicate(s)) return s;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const s = read();
  throw new Error(`Timed out. status=${s?.status} phase=${s?.phase} error=${s?.error}`);
}
