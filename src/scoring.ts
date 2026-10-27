import type { Ballot, DecisionOption, OptionScore } from './types.ts';
import { isRecord } from './util.ts';

export interface Criterion {
  id: string;
  label: string;
  weight: number;
  hint: string;
}

/** Fixed rubric so scores are comparable across sessions. Weights sum to 100. Higher is always better. */
export const CRITERIA: Criterion[] = [
  { id: 'upside', label: 'Upside', weight: 20, hint: 'Size of the prize if it works' },
  { id: 'downside', label: 'Downside protection', weight: 20, hint: 'How survivable the worst case is' },
  { id: 'economics', label: 'Economics', weight: 15, hint: 'Cash, margins, payback and ROI' },
  { id: 'fit', label: 'Founder fit', weight: 15, hint: 'Skills, energy and unfair advantage' },
  { id: 'execution', label: 'Execution', weight: 10, hint: 'Doable with current time, money and team' },
  { id: 'timing', label: 'Timing', weight: 10, hint: 'Why now: market window and life stage' },
  { id: 'reversibility', label: 'Reversibility', weight: 10, hint: 'Two-way door? Cost of undoing it' },
];

export function clampScore(value: unknown, fallback = 5): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/** 1-10 per criterion -> 10-100 overall. */
export function weightedTotal(scores: Record<string, number>): number {
  let sum = 0;
  for (const c of CRITERIA) sum += (scores[c.id] ?? 5) * c.weight;
  return Math.round(sum / 10);
}

function matchesOption(value: unknown, option: DecisionOption): boolean {
  const v = String(value ?? '').trim();
  return v.toUpperCase() === option.id || v.toLowerCase() === option.label.toLowerCase();
}

function pickCriterion(criteria: unknown, id: string): unknown {
  if (Array.isArray(criteria)) return criteria.find(c => isRecord(c) && c.id === id);
  if (isRecord(criteria)) return criteria[id];
  return undefined;
}

/** Tolerant normaliser for the chair's scorecard: accepts criteria as an object or an array. */
export function normalizeScores(raw: unknown, options: DecisionOption[]): OptionScore[] {
  const entries = (Array.isArray(raw) ? raw : []).filter(isRecord);
  return options.map((option, i) => {
    const entry = entries.find(e => matchesOption(e.option ?? e.optionId ?? e.id, option)) ?? entries[i];
    const source = entry ? (entry.criteria ?? entry.scores) : undefined;
    const criteria = CRITERIA.map(c => {
      const v = pickCriterion(source, c.id);
      const score = clampScore(isRecord(v) ? v.score : v);
      const why = isRecord(v) && typeof v.why === 'string' ? v.why.trim().slice(0, 200) : '';
      return { id: c.id, score, why };
    });
    const total = weightedTotal(Object.fromEntries(criteria.map(c => [c.id, c.score])));
    return { optionId: option.id, criteria, total };
  });
}

export function tally(ballots: Ballot[], options: DecisionOption[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(options.map(o => [o.id, 0]));
  for (const b of ballots) if (b.vote in counts) counts[b.vote] = (counts[b.vote] ?? 0) + 1;
  return counts;
}
