import { isRecord } from './util.ts';

/**
 * Every model turn is spoken words followed by an optional machine-readable block:
 *   ...spoken words...
 *   <meta>{"leaning":"A","conviction":7}</meta>
 */
export interface ParsedOutput {
  speech: string;
  meta: Record<string, unknown> | null;
}

export function splitMeta(raw: string): { speech: string; metaText: string | null } {
  const tag = raw.search(/<meta\b/i);
  if (tag >= 0) return { speech: raw.slice(0, tag), metaText: raw.slice(tag) };
  // Fallback: a trailing fenced JSON block.
  const fence = raw.search(/```(?:json)?\s*\{[\s\S]*\}\s*```\s*$/i);
  if (fence >= 0) return { speech: raw.slice(0, fence), metaText: raw.slice(fence) };
  return { speech: raw, metaText: null };
}

export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/<\/?meta[^>]*>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const body = cleaned.slice(start, end + 1);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) return value;
    } catch {
      // try the next repair
    }
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remove a leading speaker label ("Warren Buffett:", "**Chair:**") and stray wrapping quotes. */
export function cleanSpeech(speech: string, names: string[] = []): string {
  let s = speech.trim();
  const labels = [...names, 'The Chair', 'Chair'].filter(Boolean).map(escapeRe);
  const label = new RegExp(`^(?:\\*\\*|\\[)?\\s*(?:${labels.join('|')})\\s*(?:\\]|\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*`, 'i');
  s = s.replace(label, '');
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"') && !s.slice(1, -1).includes('"')) s = s.slice(1, -1);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

export function parseOutput(raw: string, names: string[] = []): ParsedOutput {
  const { speech, metaText } = splitMeta(raw);
  return { speech: cleanSpeech(speech, names), meta: metaText ? extractJson(metaText) : null };
}
