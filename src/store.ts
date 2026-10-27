import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, SessionSummary } from './types.ts';
import { nowIso, sleep } from './util.ts';

export const SESSION_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;

/** Sessions live in memory and are mirrored to one JSON file each: data/sessions/<id>.json */
export class Store {
  readonly dir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  load(): number {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as Session;
        if (!s || typeof s.id !== 'string' || !SESSION_ID.test(s.id)) continue;
        s.live = [];
        s.queue ??= [];
        // The process that was running this session is gone.
        if (s.status === 'running') s.status = 'interrupted';
        this.sessions.set(s.id, s);
      } catch (err) {
        console.warn(`[store] skipped unreadable session file ${file}: ${(err as Error).message}`);
      }
    }
    return this.sessions.size;
  }

  get(id: string): Session | undefined {
    return SESSION_ID.test(id) ? this.sessions.get(id) : undefined;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  list(): SessionSummary[] {
    return this.all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(s => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        status: s.status,
        phase: s.phase,
        provider: s.input.provider,
        model: s.input.model,
        advisorCount: s.input.advisors.length,
        verdictLabel: s.verdict?.label ?? null,
        score: s.verdict?.score ?? null,
      }));
  }

  save(s: Session): Promise<void> {
    s.updatedAt = nowIso();
    this.sessions.set(s.id, s);
    return this.schedule(s.id);
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.sessions.delete(id);
    await this.inflight.get(id);
    try {
      await unlink(this.file(id));
    } catch {
      // already gone
    }
    return existed;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Coalesce bursts of saves into at most one write in flight per session. */
  private schedule(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) {
      this.dirty.add(id);
      return running;
    }
    const work = async () => {
      do {
        this.dirty.delete(id);
        const s = this.sessions.get(id);
        if (s) await writeAtomic(this.file(id), JSON.stringify({ ...s, live: [] }, null, 2));
      } while (this.dirty.has(id));
    };
    const promise = work()
      .catch(err => console.error(`[store] could not save session ${id}:`, err))
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Sync clients (OneDrive, Dropbox) and antivirus can briefly lock the target on Windows.
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 4) {
        await sleep(60 * (attempt + 1));
        continue;
      }
      await writeFile(path, data, 'utf8');
      await unlink(tmp).catch(() => {});
      return;
    }
  }
}
