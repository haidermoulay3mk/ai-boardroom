import { randomBytes } from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();

/** Sortable, filename-safe id: 20261026-142233-a1b2c3 */
export function newSessionId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export const newTurnId = (): string => `t_${randomBytes(6).toString('hex')}`;

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce untrusted input (model output or request bodies) to a bounded string. */
export function asString(value: unknown, max = 2000): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function firstLine(text: string, max: number): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Run fn over items with at most `limit` in flight. Rejects on the first failure. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
