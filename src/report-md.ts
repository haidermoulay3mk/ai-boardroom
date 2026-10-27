import { CRITERIA } from './scoring.ts';
import type { Session } from './types.ts';

export const DISCLAIMER =
  'The advisors are AI simulations inspired by the publicly known ideas of the people named. They are not affiliated with, and have not endorsed, this app or its output. This is not financial, legal or professional advice.';

export function speakerName(s: Session, id: string): string {
  if (id === 'founder') return 'You';
  if (id === 'chair') return 'The Chair';
  return s.cast.find(a => a.id === id)?.name ?? id;
}

export function optionLabel(s: Session, id: string): string {
  return s.intake?.options.find(o => o.id === id)?.label ?? id;
}

const date = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });

export function renderMarkdown(s: Session): string {
  const out: string[] = [`# ${s.title}`, '', `*Boardroom session · ${date(s.createdAt)} · ${s.input.model}*`, ''];
  out.push('## The decision', '', s.input.decision, '');
  if (s.input.context) out.push('**Context:** ' + s.input.context, '');

  const v = s.verdict;
  if (v) {
    out.push(`## Verdict: ${v.label} (${v.score}/100)`, '', `**${v.headline}**`, '', `Confidence: ${v.confidence}`, '', v.speech, '');
    const options = s.intake?.options ?? [];
    out.push('### Scorecard', '', `| Criterion | Weight | ${options.map(o => `${o.id}: ${o.label}`).join(' | ')} |`);
    out.push(`|---|---|${options.map(() => '---').join('|')}|`);
    for (const c of CRITERIA) {
      const cells = options.map(o => v.scores.find(x => x.optionId === o.id)?.criteria.find(x => x.id === c.id)?.score ?? '-');
      out.push(`| ${c.label} | ${c.weight}% | ${cells.join(' | ')} |`);
    }
    out.push(`| **Total** | 100% | ${options.map(o => `**${v.scores.find(x => x.optionId === o.id)?.total ?? '-'}**`).join(' | ')} |`, '');
    out.push('### Board vote', '');
    for (const b of s.ballots) out.push(`- **${speakerName(s, b.advisorId)}**: ${optionLabel(s, b.vote)} (conviction ${b.conviction}/10). ${b.reason}`);
    out.push('');
    const section = (title: string, items: string[]) => {
      if (!items.length) return;
      out.push(`### ${title}`, '', ...items.map(i => `- ${i}`), '');
    };
    section('Strongest case for', v.strongestFor.map(x => `${x.text}${x.by ? ` (${speakerName(s, x.by)})` : ''}`));
    section('Strongest case against', v.strongestAgainst.map(x => `${x.text}${x.by ? ` (${speakerName(s, x.by)})` : ''}`));
    section('Conditions', v.conditions);
    section('Key risks', v.risks.map(r => `${r.risk}${r.mitigation ? ` → ${r.mitigation}` : ''}`));
    if (v.nextSteps.length) out.push('### Next 14 days', '', ...v.nextSteps.map((x, i) => `${i + 1}. ${x}`), '');
    section('What would change the verdict', v.wouldChange);
    if (v.dissent) out.push('### Dissent', '', v.dissent, '');
  }

  if (s.intake?.questions.length) {
    out.push("## The chair's questions", '');
    for (const q of s.intake.questions) out.push(`**${q.text}**`, '', s.intake.answers?.[q.id] || '*(skipped)*', '');
  }

  out.push('## Transcript', '');
  for (const t of s.turns) {
    if (t.kind === 'intake' || t.kind === 'ballot') continue;
    out.push(`**${speakerName(s, t.speaker)}:** ${t.text}`, '');
  }
  out.push('---', '', `*${DISCLAIMER}*`, '');
  return out.join('\n');
}
