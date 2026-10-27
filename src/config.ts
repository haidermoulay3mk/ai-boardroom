import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Depth } from './types.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_NAME = 'Boardroom';

const flag = (name: string): boolean => process.argv.includes(name);

export const config = {
  port: Number(process.env.PORT) || 3737,
  host: process.env.HOST || '127.0.0.1',
  dataDir: resolve(process.env.BOARDROOM_DATA_DIR || join(ROOT, 'data')),
  advisorsDir: join(ROOT, 'advisors'),
  publicDir: join(ROOT, 'public'),
  /** Absolute path to the claude executable, if it isn't on PATH. */
  claudePath: process.env.CLAUDE_PATH || '',
  /** Extra flags passed to every `claude -p` call, e.g. "--setting-sources user". */
  claudeExtraArgs: (process.env.BOARDROOM_CLAUDE_ARGS || '').split(' ').filter(Boolean),
  openBrowser: !flag('--no-open') && process.env.BOARDROOM_NO_OPEN !== '1',
  demoOnly: flag('--demo'),
  ballotConcurrency: 4,
  warmPoolSize: 2,
};

export const MODELS = [
  { id: 'sonnet', label: 'Sonnet', note: 'Balanced. Recommended.' },
  { id: 'opus', label: 'Opus', note: 'Deepest reasoning. Slower, uses more of your plan.' },
  { id: 'haiku', label: 'Haiku', note: 'Fastest and lightest on your plan.' },
];

export const DEPTHS: Record<Depth, { label: string; rounds: number; speakers: number; note: string }> = {
  quick: { label: 'Quick', rounds: 1, speakers: 3, note: '1 debate round' },
  standard: { label: 'Standard', rounds: 2, speakers: 3, note: '2 debate rounds' },
  deep: { label: 'Deep', rounds: 3, speakers: 4, note: '3 debate rounds, more voices each' },
};
