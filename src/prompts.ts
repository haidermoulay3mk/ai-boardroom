import type { Cast } from './advisors.ts';
import { DEPTHS } from './config.ts';
import { CRITERIA, tally } from './scoring.ts';
import type { Advisor, Session } from './types.ts';
import { listNames } from './util.ts';

/** Shared system prompt for every call. The role and task travel in the user message. */
export const ENGINE_SYSTEM = `You are the voice engine behind Boardroom, a local app where a founder brings a hard decision to a simulated board of advisors.

Every request casts you as exactly one speaker (the Chair, or an advisor persona inspired by a well-known business figure's publicly known ideas) and gives you one task.

- Stay strictly in the assigned role, voice and length.
- Output only that speaker's spoken words, followed by the <meta> block when the task asks for one. No preamble, no speaker label, no stage directions, no markdown headings.
- Personas are simulations built from public ideas. Speak in their first person, but never invent private anecdotes, statistics or quotes and present them as real.
- Be genuinely useful to the founder: specific, honest, and grounded in what they actually told you. Flattery is useless to them.`;

const WORDS = {
  intake: [20, 60],
  welcome: [45, 90],
  opening: [90, 140],
  moderate: [35, 75],
  response: [70, 120],
  ballot: [15, 45],
  verdict: [120, 190],
} as const;

type Line = string | false | null | undefined;
const lines = (...parts: Line[]): string => parts.filter((p): p is string => typeof p === 'string').join('\n');

export function speaker(cast: Cast, s: Session, id: string): Advisor {
  if (id === 'chair') return cast.chair;
  const full = cast.byId.get(id);
  if (full) return full;
  const snap = s.cast.find(a => a.id === id);
  return snap
    ? { ...snap, persona: '' }
    : { id, role: 'advisor', name: id, short: id, title: '', initials: id.slice(0, 2).toUpperCase(), color: '#5b6472', seat: 99, lens: '', persona: '' };
}

function label(cast: Cast, s: Session, id: string): string {
  if (id === 'founder') return 'Founder';
  if (id === 'chair') return 'Chair';
  return speaker(cast, s, id).name;
}

export function latestLeaning(s: Session, id: string): string | null {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const t = s.turns[i];
    if (t && t.speaker === id && typeof t.meta?.leaning === 'string') return t.meta.leaning;
  }
  return null;
}

function optionIds(s: Session): string {
  const ids = s.intake?.options.map(o => o.id) ?? ['A', 'B'];
  return ids.length > 1 ? `${ids.slice(0, -1).join(', ')} or ${ids[ids.length - 1]}` : (ids[0] ?? 'A');
}

/** Stable prefix shared by every prompt in a session (keeps prompt caching effective). */
export function briefing(s: Session, cast: Cast): string {
  const out: string[] = [
    '# BOARD MEETING BRIEFING',
    '',
    '## The decision on the table',
    s.input.decision.trim(),
    '',
    "## Founder's context",
    s.input.context.trim() || '(none given)',
  ];
  if (s.intake) {
    out.push('', '## How the chair framed it', s.intake.framing, '', 'Options the board will vote on:');
    for (const o of s.intake.options) out.push(`- ${o.id}: ${o.label}. ${o.description}`);
    if (s.intake.questions.length) {
      out.push('', "## The chair's questions and the founder's answers");
      for (const q of s.intake.questions) {
        out.push(`Q: ${q.text}`, `A: ${s.intake.answers?.[q.id]?.trim() || '(the founder skipped this question)'}`);
      }
    }
  }
  out.push('', '## Seated advisors');
  for (const id of s.input.advisors) {
    const a = speaker(cast, s, id);
    out.push(`- ${a.name} (${a.title}). Lens: ${a.lens}`);
  }
  const transcript = s.turns
    .filter(t => t.kind !== 'intake' && t.kind !== 'ballot' && t.kind !== 'verdict')
    .map(t => `[${label(cast, s, t.speaker)}] ${t.text}`);
  out.push('', '## Transcript so far', transcript.length ? transcript.join('\n\n') : '(the meeting has not started yet)');
  return out.join('\n');
}

function advisorRole(a: Advisor, [min, max]: readonly [number, number]): string {
  return lines(
    `## Your role: ${a.name}, ${a.title}`,
    `You are voicing an AI simulation of ${a.name}, built only from ${a.short}'s publicly known ideas and style. Speak in first person as ${a.short}.`,
    '',
    a.persona,
    '',
    'Ground rules:',
    '- You are sitting at a boardroom table, talking. No lists, no headings, no bold, no emojis.',
    "- Work from what the founder actually told you. If a fact you need is missing, say what you would need to know and how it would change your view.",
    '- Refer to other advisors by first name when you agree or disagree. Real disagreement is welcome; echoing others is not.',
    '- Never invent personal anecdotes, statistics or quotes and present them as real. No long quotes from books.',
    `- Length: ${min} to ${max} words.`,
  );
}

function chairRole(chair: Advisor): string {
  return lines(
    '## Your role: the Chair',
    chair.persona,
    '',
    'Ground rules:',
    '- You run the meeting. Stay neutral until the verdict, then be decisive.',
    '- Talk like a person at a table: no lists, headings, bold or emojis in your spoken words.',
    '- Address advisors by first name and the founder as "you".',
  );
}

function format(shape: string | null): string {
  if (!shape) return lines('## Output format', 'Your spoken words only. No speaker label and no meta block.');
  return lines(
    '## Output format',
    'Your spoken words first. Then a new line, then exactly one block like this, with valid JSON inside:',
    `<meta>${shape}</meta>`,
    'Write nothing after </meta>.',
  );
}

const leaningShape = (s: Session) => `{"leaning":"<${optionIds(s)}>","conviction":<1-10>}`;

export const INTAKE_SHAPE =
  '{"title":"<7 words or fewer>","framing":"<one sentence: the real decision>","options":[{"id":"A","label":"<4 words or fewer>","description":"<one sentence>"},{"id":"B","label":"...","description":"..."}],"questions":[{"id":"q1","text":"<short question>","why":"<what the answer would change>"}]}';

export function intakePrompt(s: Session, cast: Cast): string {
  return lines(
    briefing(s, cast),
    '',
    chairRole(cast.chair),
    '',
    '## Your task: intake, before the meeting starts',
    'The founder has just brought this decision to the board. No advisor has spoken yet.',
    `1. Say ${WORDS.intake[0]} to ${WORDS.intake[1]} words to the founder: show you understand what is really at stake, and tell them you have a few questions before the board weighs in. Do not list the questions in your spoken words; they go in the meta block.`,
    '2. Frame the decision as 2 to 4 mutually exclusive options the board will vote on. For a yes/no decision use "Do it" and "Don\'t", and add a middle path (such as "Test it small first") only if one is genuinely distinct. Labels are 4 words or fewer.',
    '3. Ask 2 to 4 short, sharp questions whose answers would most change the advice: money and runway, evidence of demand, deadlines, what they have already tried, constraints they have not mentioned. Never ask something they already told you. If their context is rich, ask fewer.',
    '4. Give the decision a short title.',
    '',
    format(INTAKE_SHAPE),
  );
}

export function welcomePrompt(s: Session, cast: Cast): string {
  const first = speaker(cast, s, s.input.advisors[0] ?? '');
  return lines(
    briefing(s, cast),
    '',
    chairRole(cast.chair),
    '',
    '## Your task: open the meeting',
    `Open the meeting in ${WORDS.welcome[0]} to ${WORDS.welcome[1]} words. Restate the decision crisply using the most important facts from the founder's answers, name the core tension the board has to resolve, and hand the floor to ${first.short} for the first opening statement.`,
    '',
    format(null),
  );
}

export function openingPrompt(s: Session, cast: Cast, id: string): string {
  const a = speaker(cast, s, id);
  const spoken = s.turns.filter(t => t.kind === 'opening').map(t => speaker(cast, s, t.speaker).short);
  return lines(
    briefing(s, cast),
    '',
    advisorRole(a, WORDS.opening),
    '',
    '## Your task: opening statement',
    'Give your opening position: which option you lean toward and the single most important reason, seen through your lens.',
    spoken.length
      ? `${listNames(spoken)} ${spoken.length === 1 ? 'has' : 'have'} already spoken. You may react briefly to one of them by name, but lead with your own view.`
      : 'You are the first advisor to speak.',
    spoken.length > 0 &&
      'Form your position from your own instincts, not from where the room is heading. Herding makes the board useless to the founder. If you do land where others did, say what you see that they missed, or the condition you would attach.',
    '',
    format(leaningShape(s)),
  );
}

export function moderatePrompt(s: Session, cast: Cast, round: number, allowAsk: boolean): string {
  const { rounds, speakers } = DEPTHS[s.input.depth];
  const seated = s.input.advisors.map(id => {
    const a = speaker(cast, s, id);
    const answered = s.turns.filter(t => t.speaker === id && t.kind === 'response').length;
    return `- ${id} = ${a.name} (${a.short}). Currently leaning ${latestLeaning(s, id) ?? 'unknown'}. Has answered ${answered} debate question${answered === 1 ? '' : 's'}.`;
  });
  const founderSpoke = s.turns[s.turns.length - 1]?.speaker === 'founder';
  return lines(
    briefing(s, cast),
    '',
    chairRole(cast.chair),
    '',
    `## Your task: run debate round ${round + 1} of ${rounds}`,
    'Find the sharpest disagreement, or the weakest unexamined assumption, in the discussion so far.',
    `Then call on 2 to ${speakers} advisors by first name with one pointed question that forces them to engage each other directly. Prefer advisors who disagree, and bring in anyone who has been quiet.`,
    founderSpoke && 'The founder just spoke. Make sure the board responds to what they said.',
    round === rounds - 1 && 'This is the last round before the vote, so aim at the question that will decide it.',
    allowAsk
      ? 'If, and only if, a missing fact from the founder is blocking a good decision, you may also ask the founder ONE short question. Put it in "ask_founder" and do not say it out loud. Otherwise set "ask_founder" to null.'
      : 'Do not ask the founder anything this round. "ask_founder" must be null.',
    `Keep your spoken words to ${WORDS.moderate[0]} to ${WORDS.moderate[1]} words.`,
    '',
    'Seated advisors (use these ids in "next"):',
    ...seated,
    '',
    format('{"next":["<advisor id>","<advisor id>"],"ask_founder":null}'),
    '"next" lists the advisors you called on, in the order they should answer.',
  );
}

export function responsePrompt(s: Session, cast: Cast, id: string, round: number): string {
  const a = speaker(cast, s, id);
  const r = s.rounds.find(x => x.index === round);
  const question = s.turns.find(t => t.id === r?.moderatorTurnId);
  const others = (r?.next ?? []).filter(x => x !== id).map(x => speaker(cast, s, x).short);
  return lines(
    briefing(s, cast),
    '',
    advisorRole(a, WORDS.response),
    '',
    `## Your task: answer the chair (round ${round + 1})`,
    question && `The chair just said: "${question.text}"`,
    'Answer directly, from your lens. Engage at least one other advisor by first name: push back, concede, or build on their point.',
    others.length > 0 && `${listNames(others)} ${others.length === 1 ? 'is' : 'are'} also answering this round.`,
    'If you have been persuaded, change your leaning and say so plainly. If the founder has spoken since the chair asked, respond to them too.',
    '',
    format(leaningShape(s)),
  );
}

export function ballotPrompt(s: Session, cast: Cast, id: string): string {
  const a = speaker(cast, s, id);
  return lines(
    briefing(s, cast),
    '',
    advisorRole(a, WORDS.ballot),
    '',
    '## Your task: final ballot',
    'The debate is over. Vote independently, as if nobody else will see your ballot. In one or two sentences, state your vote and the decisive reason.',
    '',
    format(`{"vote":"<${optionIds(s)}>","conviction":<1-10>}`),
  );
}

export function verdictShape(s: Session): string {
  const ids = s.intake?.options.map(o => o.id) ?? ['A', 'B'];
  const crit = CRITERIA.map(c => `"${c.id}":{"score":<1-10>,"why":"..."}`).join(',');
  const scores = ids.map(id => `{"option":"${id}","criteria":{${crit}}}`).join(',');
  return `{"recommendation":"<option id>","label":"<4 words or fewer: the call, e.g. Go, with conditions>","headline":"<one-sentence verdict>","confidence":"<low|medium|high>","scores":[${scores}],"strongest_for":[{"text":"...","by":"<advisor id>"}],"strongest_against":[{"text":"...","by":"<advisor id>"}],"conditions":["..."],"risks":[{"risk":"...","mitigation":"..."}],"next_steps":["...","...","..."],"would_change":["..."],"dissent":"<who dissented and why, one sentence>"}`;
}

export function verdictPrompt(s: Session, cast: Cast): string {
  const options = s.intake?.options ?? [];
  const ballots = s.input.advisors.map(id => {
    const a = speaker(cast, s, id);
    const b = s.ballots.find(x => x.advisorId === id);
    return b ? `- ${a.name} (${id}): ${b.vote}, conviction ${b.conviction}/10. "${b.reason}"` : `- ${a.name} (${id}): did not vote`;
  });
  const counts = tally(s.ballots, options);
  const tallyLine = `Tally: ${options.map(o => `${o.id} (${o.label}) ${counts[o.id] ?? 0}`).join(', ')}.`;
  return lines(
    briefing(s, cast),
    '',
    chairRole(cast.chair),
    '',
    '## Your task: deliver the verdict',
    'The board has voted:',
    ...ballots,
    tallyLine,
    '',
    "Weigh the arguments, not just the headcount. The founder's real constraints and the quality of reasoning matter more than the vote count.",
    `1. Speak the verdict to the founder in ${WORDS.verdict[0]} to ${WORDS.verdict[1]} words: your recommendation, the two or three reasons that decided it, the strongest dissent and why it did not win, and any conditions. Be direct. If the honest answer is uncomfortable, say it kindly and plainly.`,
    '2. Score EVERY option on each criterion from 1 (very poor) to 10 (excellent). Higher is always better:',
    ...CRITERIA.map(c => `- ${c.id}: ${c.label}, weight ${c.weight}%. ${c.hint}.`),
    '3. Your recommendation must be the option with the highest weighted score. If your judgment disagrees with the numbers, revisit the scores honestly until they agree.',
    '4. Next steps are concrete actions the founder can start within 14 days.',
    '',
    format(verdictShape(s)),
    'In "by" fields use advisor ids. Keep every "why" under 15 words.',
  );
}

export function repairPrompt(raw: string, shape: string): string {
  return lines(
    '## Your task: fix a formatting problem',
    'The text below was supposed to end with a <meta> block containing JSON of this shape:',
    shape,
    '',
    'Recover or reconstruct that JSON from the text, keeping its content and judgments. Output ONLY the JSON object: no prose, no code fences, no <meta> tags.',
    '',
    'TEXT:',
    raw.slice(0, 12000),
  );
}
