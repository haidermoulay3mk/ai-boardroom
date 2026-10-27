import { CRITERIA } from '../scoring.ts';
import type { Session } from '../types.ts';
import { sleep } from '../util.ts';
import { AbortError, type GenerateHint, type GenerateOptions, type GenerateResult, type Provider, type ProviderHealth } from './types.ts';

/**
 * Scripted board for trying the app with no AI at all (and for tests).
 * Lines are generic on purpose: the real debate comes from Claude Code.
 */

type Lean = 'go' | 'no' | 'mid';
interface Voice {
  lean: Lean;
  opening: string;
  response: string;
  ballot: string;
}

const LEAN_TO_OPTION: Record<Lean, string> = { go: 'A', no: 'B', mid: 'C' };

const VOICES: Record<string, Voice> = {
  buffett: {
    lean: 'no',
    opening:
      "Let me start where I always start: what happens if this goes wrong? You can recover from a lot of mistakes, but not from the ones that take you out of the game. If you understand this business better than almost anyone, it's inside your circle of competence and I'd look hard at it. If not, the cheapest education is patience. I lean toward {no} for now, and I'd want a much bigger margin of safety before I changed my mind.",
    response:
      "{other}, I admire the energy, but energy isn't a margin of safety. The question I'd put to our founder is simple: if this takes twice as long and costs twice as much, are you still standing? If the answer is yes, I'll soften. If it's 'probably', that word has hurt a lot of smart people.",
    ballot: '{pick}. Protect the downside first; if the opportunity is real, it will still be there when the odds are better.',
  },
  cardone: {
    lean: 'go',
    opening:
      "Obscurity is your biggest problem, not risk. Everybody at this table is going to tell you to be careful, and careful is how you end up average. If you believe in this, you go with {go} and you take ten times the action you planned. Set the target ten times higher, make the calls, follow up until they say yes. Massive action fixes most of what the cautious people are worried about.",
    response:
      "{other}, with respect, waiting is a decision too, and it's usually the most expensive one. You don't get a margin of safety by sitting still. You get it by selling. Make a hundred offers this month and the data will answer everything you're guessing about.",
    ballot: '{pick}. Commit, go all in, and outwork the doubt.',
  },
  graham: {
    lean: 'mid',
    opening:
      "The question I care about is whether anyone actually wants this badly. Not whether it sounds plausible, but whether a small number of people would be genuinely upset if it went away. If you have that, even with a handful of users, keep going. If you don't, the answer isn't to plan harder, it's to find out quickly. That's why I lean toward {mid}: do the things that don't scale, get ten real users, and let them tell you.",
    response:
      "{other} is right about speed, but I'd aim it differently. A big push before you know what users want just makes the wrong thing louder. Launch something small this week, talk to every user yourself, and watch whether growth happens without you forcing it.",
    ballot: '{pick}. Get real users before you bet big; their behaviour will settle this better than we can.',
  },
  hormozi: {
    lean: 'mid',
    opening:
      "Let's do the math instead of the feelings. Value is the dream outcome times the likelihood of getting it, divided by the time and effort it takes. Right now you don't know the likelihood, so you're pricing a guess. I lean toward {mid}: build an offer so good people feel stupid saying no, put it in front of a hundred people, and count how many pay. Volume beats luck. In thirty days you'll know.",
    response:
      "{other}, I agree with the intensity but not the order. Don't scale a thing that hasn't sold. Get one offer, one customer type and one channel working, then pour fuel on it. If ten people won't pay, a thousand won't either. That's arithmetic, not pessimism.",
    ballot: "{pick}. Sell it before you scale it; let paying customers make the call.",
  },
  bezos: {
    lean: 'go',
    opening:
      "First question: is this a one-way door or a two-way door? Most decisions are reversible, and those should be made fast, with about seventy percent of the information you wish you had. Second, picture yourself at eighty. Will you regret not trying? For a reversible bet with a real customer at the centre, I lean toward {go}. Start with the customer and work backwards.",
    response:
      "{other} is treating this like a one-way door, and I don't think it is. If you can undo it in six months at a tolerable cost, the bigger risk is moving too slowly. Set a clear checkpoint, define what success looks like, and go.",
    ballot: "{pick}. It's a two-way door with real upside; decide fast and keep the customer at the centre.",
  },
  vaynerchuk: {
    lean: 'go',
    opening:
      "Real talk: the strategy matters less than your self-awareness. Do you actually love this, or do you love the idea of it? If you love it, you play the long game, you document everything, and you build attention while everybody else is busy overthinking. Patience on the outcome, speed on the daily work. I lean toward {go}, on a timeline that keeps you happy and sane.",
    response:
      "{other} is giving you great business advice, but I care about the human here. If this decision makes you miserable for two years, the spreadsheet doesn't matter. Start putting out content about the journey today. Attention is the asset, and it compounds either way.",
    ballot: '{pick}. Bet on yourself, play the long game, and keep your happiness in the equation.',
  },
  wickman: {
    lean: 'mid',
    opening:
      "Let's step back and look at the vision. Does this fit your core focus, the thing you're truly great at and passionate about? If it does, it deserves to be one of your priorities for the next ninety days, with one owner and a number you check every week. If it doesn't, it's a shiny distraction, and distractions kill traction. I lean toward {mid} until we can see it on a scorecard.",
    response:
      "The real issue {other} is circling isn't ambition, it's clarity. Write down what done looks like in ninety days, pick three to five weekly numbers, and review them every week. If the numbers move, scale up. If they don't, you'll know without a fight.",
    ballot: '{pick}. Make it a ninety-day priority with clear numbers, then decide with data.',
  },
  martell: {
    lean: 'mid',
    opening:
      "Before we talk strategy, let's talk time. Will this buy back your time, or trap you in a job you invented? Most founders say yes to things that put them on the hook for every task. If you go ahead, design it so the low-value work can be handed off from day one. Record what you do, hand it off, stay where you add the most value. I lean toward {mid}, with a system behind it.",
    response:
      "{other} has a point, but here's the playbook I'd add. List every task this decision creates, split it into what drains you and what lights you up, and plan to hand off the first group. If you can't afford any help yet, that tells you the economics need work before you go big.",
    ballot: '{pick}. Do it in a way that buys back your time instead of eating it.',
  },
};

const GENERIC: Voice = {
  lean: 'mid',
  opening: 'Through my lens, the deciding factor is evidence. I lean toward {mid}: get proof quickly and cheaply, then commit.',
  response: "{other} makes a fair point, but I'd still want proof before committing everything.",
  ballot: '{pick}. Evidence first, then commitment.',
};

const voiceOf = (id: string): Voice => VOICES[id] ?? GENERIC;

function optionLabel(s: Session, lean: Lean): string {
  const options = s.intake?.options ?? [];
  return (options.find(o => o.id === LEAN_TO_OPTION[lean]) ?? options[0])?.label ?? 'the cautious path';
}

function nameOf(s: Session, id: string): string {
  return s.cast.find(a => a.id === id)?.short ?? id;
}

function fill(template: string, s: Session, extra: Record<string, string> = {}): string {
  const vars: Record<string, string> = {
    go: optionLabel(s, 'go'),
    no: optionLabel(s, 'no'),
    mid: optionLabel(s, 'mid'),
    ...extra,
  };
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? key);
}

const meta = (value: unknown): string => `\n<meta>${JSON.stringify(value)}</meta>`;

function script(h: GenerateHint): string {
  const s = h.session;
  const seated = s.input.advisors;
  switch (h.kind) {
    case 'intake': {
      const title = s.input.decision.split(/[.?!\n]/)[0]?.slice(0, 60).trim() || 'Your decision';
      return (
        "Thanks for bringing this to the board. Before anyone weighs in, I need a few facts from you, because the right answer changes a lot depending on them." +
        meta({
          title,
          framing: `Whether to commit to this now: ${s.input.decision.slice(0, 160)}`,
          options: [
            { id: 'A', label: 'Go all in', description: 'Commit fully and move now.' },
            { id: 'B', label: "Don't do it", description: 'Pass and keep your current course.' },
            { id: 'C', label: 'Test it small first', description: 'Run a cheap, time-boxed experiment before committing.' },
          ],
          questions: [
            { id: 'q1', text: 'How many months of runway do you have if this earns nothing?', why: 'Decides how much risk you can carry.' },
            { id: 'q2', text: 'What evidence do you have that customers want this?', why: 'Separates a bet from a guess.' },
            { id: 'q3', text: 'What is your deadline, and what happens if you wait three months?', why: 'Tests whether speed matters.' },
          ],
        })
      );
    }
    case 'welcome': {
      const first = nameOf(s, seated[0] ?? '');
      return `Let's begin. ${s.intake?.framing ?? ''} The tension is plain: real upside on one side, risk and focus on the other. Each of you will give an opening position, then we'll go at the disagreements. ${first}, the floor is yours.`;
    }
    case 'opening': {
      const v = voiceOf(h.speaker);
      return fill(v.opening, s) + meta({ leaning: LEAN_TO_OPTION[v.lean], conviction: 7 });
    }
    case 'moderate': {
      const round = h.round ?? 0;
      const goers = seated.filter(id => voiceOf(id).lean === 'go');
      const holders = seated.filter(id => voiceOf(id).lean !== 'go');
      const a = goers[round % Math.max(1, goers.length)] ?? seated[0] ?? '';
      const b = holders[round % Math.max(1, holders.length)] ?? seated[1] ?? '';
      const c = seated.find(id => id !== a && id !== b && !s.turns.some(t => t.speaker === id && t.kind === 'response')) ?? '';
      const next = [a, b, c].filter(Boolean);
      const text =
        round === 0
          ? `I'm hearing two camps. ${nameOf(s, a)}, you want to move now; ${nameOf(s, b)}, you want proof first. ${nameOf(s, a)}, what's the strongest version of ${nameOf(s, b)}'s worry, and how would you handle it? ${nameOf(s, b)}, what evidence would change your mind?${c ? ` ${nameOf(s, c)}, where do you land?` : ''}`
          : `Last round before we vote. ${nameOf(s, a)}, give me the one number that would prove this is working within ninety days. ${nameOf(s, b)}, what's the hard stop that protects the founder if it isn't?`;
      return text + meta({ next, ask_founder: null });
    }
    case 'response': {
      const v = voiceOf(h.speaker);
      const other = seated.find(id => id !== h.speaker && voiceOf(id).lean !== v.lean) ?? seated.find(id => id !== h.speaker) ?? '';
      return fill(v.response, s, { other: nameOf(s, other) }) + meta({ leaning: LEAN_TO_OPTION[v.lean], conviction: 7 });
    }
    case 'ballot': {
      const v = voiceOf(h.speaker);
      return fill(v.ballot, s, { pick: optionLabel(s, v.lean) }) + meta({ vote: LEAN_TO_OPTION[v.lean], conviction: v.lean === 'mid' ? 8 : 7 });
    }
    case 'verdict':
      return demoVerdict(s);
    default:
      return '{}';
  }
}

function demoVerdict(s: Session): string {
  const table: Record<string, number[]> = {
    A: [9, 3, 5, 7, 5, 7, 4],
    B: [2, 9, 5, 5, 9, 4, 9],
    C: [7, 8, 7, 7, 8, 7, 8],
  };
  const options = s.intake?.options ?? [];
  const scores = options.map(o => ({
    option: o.id,
    criteria: Object.fromEntries(CRITERIA.map((c, i) => [c.id, { score: table[o.id]?.[i] ?? 5, why: `Demo score for ${c.label.toLowerCase()}.` }])),
  }));
  const rec = options.find(o => o.id === 'C') ?? options[0];
  const speech = `Here's where the board lands. The strongest argument tonight wasn't for boldness or for caution, it was for evidence. ${rec?.label ?? 'The middle path'} gets you real data fast without betting everything on a guess. The case for going all in was made well, and the upside is real, but the cost of being wrong today is bigger than the cost of waiting a few weeks for proof. The dissent matters: protect your runway and set a hard stop. My recommendation is a thirty-day test with one clear success number. Hit it, and come back to this table to talk about going big.`;
  return (
    speech +
    meta({
      recommendation: rec?.id ?? 'A',
      label: rec?.label ?? 'Test first',
      headline: 'Run a 30-day experiment with one success number before committing.',
      confidence: 'medium',
      scores,
      strongest_for: [{ text: 'A reversible bet with a real customer deserves a fast decision.', by: 'bezos' }],
      strongest_against: [{ text: "If the downside takes you out of the game, upside doesn't matter.", by: 'buffett' }],
      conditions: ['Set a hard stop date and a spending cap before you start.', 'Define the one number that means it is working.'],
      risks: [{ risk: 'The test drags on and quietly eats your time.', mitigation: 'Put the end date in your calendar and decide on that day.' }],
      next_steps: ['Write a one-page offer and price it.', 'Show it to 20 potential customers this week.', 'Review the numbers in 14 days and decide.'],
      would_change: ['Five or more pre-sales would justify going all in.', 'Runway under three months would mean waiting.'],
      dissent: 'Grant would go all in today; the board judged the evidence too thin for that.',
    })
  );
}

export class DemoProvider implements Provider {
  readonly name = 'demo' as const;
  private readonly delayMs: number;

  constructor(delayMs = 28) {
    this.delayMs = delayMs;
  }

  prewarm(): void {}
  dispose(): void {}

  async health(): Promise<ProviderHealth> {
    return { name: this.name, ready: true, detail: 'Scripted responses for trying the app. No AI calls.' };
  }

  async generate(o: GenerateOptions): Promise<GenerateResult> {
    const text = o.hint ? script(o.hint) : '{}';
    if (this.delayMs > 0) await sleep(this.delayMs * 10);
    const parts = text.split(/(?<=\s)/);
    for (let i = 0; i < parts.length; i += 3) {
      if (o.signal?.aborted) throw new AbortError();
      o.onText?.(parts.slice(i, i + 3).join(''));
      if (this.delayMs > 0) await sleep(this.delayMs);
    }
    if (o.signal?.aborted) throw new AbortError();
    return { text };
  }
}
