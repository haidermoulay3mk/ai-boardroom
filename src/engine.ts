import { type Cast, publicProfile } from './advisors.ts';
import { config, DEPTHS } from './config.ts';
import type { Hub } from './hub.ts';
import { extractJson, parseOutput } from './parse.ts';
import * as P from './prompts.ts';
import type { Provider } from './providers/types.ts';
import { clampScore, normalizeScores, tally } from './scoring.ts';
import type { Store } from './store.ts';
import type {
  Attributed,
  Depth,
  Intake,
  LiveTurn,
  Pending,
  ProviderName,
  Round,
  Session,
  SessionInput,
  Turn,
  TurnKind,
  Verdict,
} from './types.ts';
import { asString, firstLine, isRecord, mapLimit, newSessionId, newTurnId, nowIso } from './util.ts';

export class InputError extends Error {
  override name = 'InputError';
}

type Meta = Record<string, unknown> | null;

const DEPTH_IDS: Depth[] = ['quick', 'standard', 'deep'];
const OPTION_IDS = 'ABCD';

const FALLBACK_QUESTIONS = [
  'How many months of runway do you have if this brings in nothing?',
  'What evidence do you already have that people want this?',
  'What happens if you wait three months before deciding?',
];

export interface EngineOptions {
  store: Store;
  hub: Hub;
  providers: Record<ProviderName, Provider>;
  cast: Cast;
  demoOnly?: boolean;
}

/**
 * Runs a board meeting as a resumable sequence of steps:
 * intake -> (founder answers) -> welcome -> openings -> debate rounds -> ballots -> verdict.
 * Every completed turn is saved, so a failed or interrupted session resumes where it stopped.
 */
export class Engine {
  private readonly store: Store;
  private readonly hub: Hub;
  private readonly providers: Record<ProviderName, Provider>;
  private readonly cast: Cast;
  private readonly demoOnly: boolean;
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private closing = false;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.providers = opts.providers;
    this.cast = opts.cast;
    this.demoOnly = opts.demoOnly ?? false;
  }

  // ---------------------------------------------------------------- public API

  validate(raw: unknown): SessionInput {
    if (!isRecord(raw)) throw new InputError('Expected a JSON object.');
    const decision = asString(raw.decision, 5000).trim();
    if (decision.length < 12) throw new InputError('Describe the decision in at least one full sentence.');
    const context = asString(raw.context, 6000).trim();
    const seatOrder = this.cast.advisors.map(a => a.id);
    const requested = Array.isArray(raw.advisors) ? raw.advisors.map(v => String(v)) : seatOrder;
    const advisors = seatOrder.filter(id => requested.includes(id));
    if (advisors.length < 2) throw new InputError('Seat at least two advisors.');
    const depth = DEPTH_IDS.find(d => d === raw.depth) ?? 'standard';
    const model = asString(raw.model, 80).trim() || 'sonnet';
    if (!/^[\w.\-[\]]+$/.test(model)) throw new InputError('That model name is not valid.');
    const provider: ProviderName = this.demoOnly || raw.provider === 'demo' ? 'demo' : 'claude-code';
    return { decision, context, advisors, depth, model, provider };
  }

  create(raw: unknown): Session {
    const input = this.validate(raw);
    const now = nowIso();
    const seated = input.advisors.map(id => this.cast.byId.get(id)).filter(a => a !== undefined);
    const s: Session = {
      id: newSessionId(),
      version: 1,
      title: firstLine(input.decision, 80),
      createdAt: now,
      updatedAt: now,
      input,
      cast: [this.cast.chair, ...seated].map(publicProfile),
      status: 'running',
      phase: 'intake',
      error: null,
      intake: null,
      turns: [],
      rounds: [],
      ballots: [],
      verdict: null,
      pending: null,
      queue: [],
      live: [],
      stats: { calls: 0 },
    };
    void this.store.save(s);
    this.providers[input.provider].prewarm(input.model);
    this.start(s.id);
    return s;
  }

  get(id: string): Session {
    const s = this.store.get(id);
    if (!s) throw new InputError('Session not found.');
    return s;
  }

  isRunning(id: string): boolean {
    return this.controllers.has(id);
  }

  answer(id: string, body: unknown): Session {
    const s = this.get(id);
    if (s.status !== 'awaiting_user' || !s.pending || !s.intake) throw new InputError('This session is not waiting for an answer.');
    const answers = isRecord(body) && isRecord(body.answers) ? body.answers : isRecord(body) ? body : {};
    if (s.pending.type === 'intake') {
      s.intake.answers = Object.fromEntries(s.intake.questions.map(q => [q.id, asString(answers[q.id], 2000).trim()]));
    } else {
      const round = s.rounds.find(r => r.index === s.pending?.round);
      if (!round) throw new InputError('That question is no longer open.');
      const text = asString(answers.answer ?? Object.values(answers)[0], 2000).trim();
      round.answered = true;
      round.founderAnswer = text || null;
      if (text) s.turns.push(this.founderTurn(text, round.index));
    }
    s.pending = null;
    s.status = 'running';
    this.commit(s);
    this.start(id);
    return s;
  }

  interject(id: string, body: unknown): Session {
    const s = this.get(id);
    const text = asString(isRecord(body) ? body.text : '', 1500).trim();
    if (!text) throw new InputError('Say something first.');
    if (s.status !== 'running') throw new InputError('The meeting is not in session.');
    if (s.phase === 'intake' || s.phase === 'ballot' || s.phase === 'verdict' || s.phase === 'done') {
      throw new InputError(s.phase === 'intake' ? 'The meeting has not started yet.' : 'Voting has started. The floor is closed.');
    }
    s.queue.push(text);
    this.commit(s);
    return s;
  }

  cancel(id: string): Session {
    const s = this.get(id);
    const controller = this.controllers.get(id);
    if (controller) controller.abort();
    else if (s.status === 'awaiting_user') {
      s.status = 'cancelled';
      s.pending = null;
      this.commit(s);
    }
    return s;
  }

  resume(id: string): Session {
    const s = this.get(id);
    if (this.controllers.has(id) || s.status === 'awaiting_user') return s;
    if (s.status === 'done') throw new InputError('This session is already finished.');
    this.providers[s.input.provider].prewarm(s.input.model);
    this.start(id);
    return s;
  }

  async remove(id: string): Promise<boolean> {
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      await this.runs.get(id);
    }
    return this.store.delete(id);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.runs.values()]);
    await this.store.flush();
  }

  // ---------------------------------------------------------------- the meeting

  private start(id: string): void {
    if (this.controllers.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const run = this.run(id, controller.signal).finally(() => {
      this.controllers.delete(id);
      this.runs.delete(id);
    });
    this.runs.set(id, run);
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const s = this.store.get(id);
    if (!s) return;
    const provider = this.providers[s.input.provider];
    s.status = 'running';
    s.error = null;
    s.pending = null;
    this.commit(s);

    try {
      if (!s.intake) {
        s.phase = 'intake';
        await this.intake(s, provider, signal);
      }
      const intake = s.intake as Intake;
      if (intake.questions.length && !intake.answers) return this.wait(s, { type: 'intake', questions: intake.questions });

      s.phase = 'opening';
      if (!this.has(s, 'chair', 'welcome')) await this.say(s, provider, signal, 'chair', 'welcome', P.welcomePrompt(s, this.cast));
      for (const advisor of s.input.advisors) {
        this.flushQueue(s);
        if (!this.has(s, advisor, 'opening')) await this.opening(s, provider, signal, advisor);
      }

      s.phase = 'debate';
      const { rounds } = DEPTHS[s.input.depth];
      for (let r = 0; r < rounds; r++) {
        this.flushQueue(s);
        const round = s.rounds.find(x => x.index === r) ?? (await this.moderate(s, provider, signal, r));
        if (round.askFounder && !round.answered) {
          return this.wait(s, { type: 'chair', round: r, questions: [{ id: 'answer', text: round.askFounder, why: '' }] });
        }
        for (const advisor of round.next) {
          this.flushQueue(s);
          if (!this.has(s, advisor, 'response', r)) await this.response(s, provider, signal, advisor, r);
        }
      }
      this.flushQueue(s);

      s.phase = 'ballot';
      this.commit(s);
      const voters = s.input.advisors.filter(a => !s.ballots.some(b => b.advisorId === a));
      await mapLimit(voters, config.ballotConcurrency, a => this.ballot(s, provider, signal, a));

      s.phase = 'verdict';
      this.commit(s);
      if (!s.verdict) await this.verdict(s, provider, signal);

      s.phase = 'done';
      s.status = 'done';
      this.commit(s);
    } catch (err) {
      s.live = [];
      if (signal.aborted) {
        s.status = this.closing ? 'interrupted' : 'cancelled';
        s.error = null;
      } else {
        s.status = 'error';
        s.error = err instanceof Error ? err.message : String(err);
        console.error(`[engine] session ${s.id} stopped:`, err);
      }
      this.commit(s);
    }
  }

  private wait(s: Session, pending: Pending): void {
    s.status = 'awaiting_user';
    s.pending = pending;
    this.commit(s);
  }

  private has(s: Session, speaker: string, kind: TurnKind, round?: number): boolean {
    return s.turns.some(t => t.speaker === speaker && t.kind === kind && (round === undefined || t.round === round));
  }

  private founderTurn(text: string, round?: number): Turn {
    const now = nowIso();
    return { id: newTurnId(), speaker: 'founder', kind: 'founder', round, text, startedAt: now, endedAt: now, durationMs: 0 };
  }

  /** The founder "raised a hand" mid-speech; they get the floor once the current speaker finishes. */
  private flushQueue(s: Session): void {
    if (!s.queue.length) return;
    for (const text of s.queue.splice(0)) s.turns.push(this.founderTurn(text));
    this.commit(s);
  }

  private commit(s: Session, persist = true): void {
    if (persist) void this.store.save(s);
    this.hub.send(s.id, 'session', s);
  }

  private async speak(
    s: Session,
    provider: Provider,
    signal: AbortSignal,
    speaker: string,
    kind: TurnKind,
    prompt: string,
    round?: number,
    stream = true,
  ): Promise<{ turn: Turn; meta: Meta; raw: string }> {
    const live: LiveTurn = { id: newTurnId(), speaker, kind, round, text: '', startedAt: nowIso() };
    s.live.push(live);
    this.commit(s, false);
    const started = Date.now();
    let raw: string;
    try {
      const result = await provider.generate({
        prompt,
        model: s.input.model,
        signal,
        onText: delta => {
          live.text += delta;
          if (stream) this.hub.send(s.id, 'delta', { id: live.id, text: delta });
        },
        onStatus: message => this.hub.send(s.id, 'status', { id: live.id, message }),
        hint: { kind, speaker, round, session: s },
      });
      raw = result.text;
    } finally {
      s.live = s.live.filter(l => l.id !== live.id);
    }
    s.stats.calls += 1;
    const who = P.speaker(this.cast, s, speaker);
    const parsed = parseOutput(raw, [who.name, who.short]);
    const turn: Turn = {
      id: live.id,
      speaker,
      kind,
      round,
      text: parsed.speech || '(passes)',
      startedAt: live.startedAt,
      endedAt: nowIso(),
      durationMs: Date.now() - started,
    };
    return { turn, meta: parsed.meta, raw };
  }

  private async say(s: Session, provider: Provider, signal: AbortSignal, speaker: string, kind: TurnKind, prompt: string): Promise<void> {
    const { turn } = await this.speak(s, provider, signal, speaker, kind, prompt);
    s.turns.push(turn);
    this.commit(s);
  }

  /** Ask the model to re-emit just the JSON when a turn's meta block came back unusable. Invisible to the UI. */
  private async repair(s: Session, provider: Provider, signal: AbortSignal, raw: string, shape: string): Promise<Meta> {
    try {
      const result = await provider.generate({
        prompt: P.repairPrompt(raw, shape),
        model: s.input.model,
        signal,
        hint: { kind: 'repair', speaker: 'chair', session: s },
      });
      s.stats.calls += 1;
      return extractJson(result.text);
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
  }

  private optionId(s: Session, value: unknown): string | null {
    const raw = asString(value, 200).trim();
    if (!raw) return null;
    const options = s.intake?.options ?? [];
    const head = /^([A-D])\b/i.exec(raw)?.[1]?.toUpperCase();
    if (head && options.some(o => o.id === head)) return head;
    const lower = raw.toLowerCase();
    return options.find(o => o.label.toLowerCase() === lower)?.id ?? null;
  }

  private leaning(s: Session, meta: Meta): Record<string, unknown> {
    return {
      leaning: this.optionId(s, meta?.leaning ?? meta?.vote),
      conviction: meta?.conviction == null ? null : clampScore(meta.conviction),
    };
  }

  private advisorRef(s: Session, value: unknown): string {
    const raw = asString(value, 80).trim();
    const lower = raw.toLowerCase();
    const hit = s.cast.find(a => a.id === lower || a.name.toLowerCase() === lower || a.short.toLowerCase() === lower);
    return hit?.id ?? raw;
  }

  // ---------------------------------------------------------------- steps

  private async intake(s: Session, provider: Provider, signal: AbortSignal): Promise<void> {
    const { turn, meta, raw } = await this.speak(s, provider, signal, 'chair', 'intake', P.intakePrompt(s, this.cast));
    const usable = (m: Meta) => m !== null && Array.isArray(m.options) && m.options.length >= 2;
    const fixed = usable(meta) ? meta : await this.repair(s, provider, signal, raw, P.INTAKE_SHAPE);
    const intake = this.normalizeIntake(s, usable(fixed) ? fixed : null);
    if (turn.text === '(passes)') turn.text = 'Before the board weighs in, I have a few questions for you.';
    s.intake = intake;
    s.title = intake.title;
    s.turns.push(turn);
    this.commit(s);
  }

  private normalizeIntake(s: Session, meta: Meta): Intake {
    const rawOptions = Array.isArray(meta?.options) ? meta.options : [];
    let options = rawOptions
      .filter(isRecord)
      .map(o => ({ label: asString(o.label, 60).trim(), description: asString(o.description, 300).trim() }))
      .filter(o => o.label)
      .slice(0, 4);
    if (options.length < 2) {
      options = [
        { label: 'Do it', description: 'Go ahead with the move as described.' },
        { label: "Don't", description: 'Pass on it and keep doing what you do today.' },
      ];
    }
    const rawQuestions = meta ? (Array.isArray(meta.questions) ? meta.questions : []) : FALLBACK_QUESTIONS;
    const questions = rawQuestions
      .map(q => (isRecord(q) ? { text: asString(q.text, 400), why: asString(q.why, 300) } : { text: asString(q, 400), why: '' }))
      .filter(q => q.text.trim())
      .slice(0, 4)
      .map((q, i) => ({ id: `q${i + 1}`, text: q.text.trim(), why: q.why.trim() }));
    return {
      title: firstLine(asString(meta?.title, 120), 80) || s.title,
      framing: asString(meta?.framing, 400).trim() || firstLine(s.input.decision, 300),
      options: options.map((o, i) => ({ id: OPTION_IDS[i] as string, ...o })),
      questions,
      answers: questions.length ? null : {},
    };
  }

  private async opening(s: Session, provider: Provider, signal: AbortSignal, advisor: string): Promise<void> {
    const { turn, meta } = await this.speak(s, provider, signal, advisor, 'opening', P.openingPrompt(s, this.cast, advisor));
    turn.meta = this.leaning(s, meta);
    s.turns.push(turn);
    this.commit(s);
  }

  private async moderate(s: Session, provider: Provider, signal: AbortSignal, index: number): Promise<Round> {
    const allowAsk = !s.rounds.some(r => r.askFounder);
    const { turn, meta } = await this.speak(s, provider, signal, 'chair', 'moderate', P.moderatePrompt(s, this.cast, index, allowAsk), index);
    const next = this.pickSpeakers(s, meta?.next);
    const ask = allowAsk ? asString(meta?.ask_founder, 400).trim() || null : null;
    turn.meta = { next, ask_founder: ask };
    s.turns.push(turn);
    const round: Round = { index, moderatorTurnId: turn.id, next, askFounder: ask, answered: !ask, founderAnswer: null };
    s.rounds.push(round);
    this.commit(s);
    return round;
  }

  /** Keep the chair's picks when valid; otherwise bring in whoever has spoken least. */
  private pickSpeakers(s: Session, raw: unknown): string[] {
    const max = DEPTHS[s.input.depth].speakers;
    const picked: string[] = [];
    for (const value of Array.isArray(raw) ? raw : []) {
      const id = this.advisorRef(s, value);
      if (s.input.advisors.includes(id) && !picked.includes(id)) picked.push(id);
    }
    const quietest = [...s.input.advisors].sort(
      (a, b) => s.turns.filter(t => t.speaker === a && t.kind === 'response').length - s.turns.filter(t => t.speaker === b && t.kind === 'response').length,
    );
    for (const id of quietest) {
      if (picked.length >= 2) break;
      if (!picked.includes(id)) picked.push(id);
    }
    return picked.slice(0, max);
  }

  private async response(s: Session, provider: Provider, signal: AbortSignal, advisor: string, round: number): Promise<void> {
    const { turn, meta } = await this.speak(s, provider, signal, advisor, 'response', P.responsePrompt(s, this.cast, advisor, round), round);
    turn.meta = this.leaning(s, meta);
    s.turns.push(turn);
    this.commit(s);
  }

  private async ballot(s: Session, provider: Provider, signal: AbortSignal, advisor: string): Promise<void> {
    const { turn, meta } = await this.speak(s, provider, signal, advisor, 'ballot', P.ballotPrompt(s, this.cast, advisor), undefined, false);
    const options = s.intake?.options ?? [];
    const vote = this.optionId(s, meta?.vote ?? meta?.leaning) ?? P.latestLeaning(s, advisor) ?? options[0]?.id ?? 'A';
    const conviction = clampScore(meta?.conviction);
    turn.meta = { vote, conviction };
    s.turns.push(turn);
    s.ballots.push({ advisorId: advisor, vote, conviction, reason: turn.text, turnId: turn.id });
    this.commit(s);
  }

  private async verdict(s: Session, provider: Provider, signal: AbortSignal): Promise<void> {
    const { turn, meta, raw } = await this.speak(s, provider, signal, 'chair', 'verdict', P.verdictPrompt(s, this.cast));
    const usable = (m: Meta) => m !== null && Array.isArray(m.scores) && m.scores.length > 0;
    const fixed = usable(meta) ? meta : await this.repair(s, provider, signal, raw, P.verdictShape(s));
    if (!fixed || !usable(fixed)) throw new Error("The chair's scorecard came back malformed. Press Retry to ask again.");
    s.verdict = this.buildVerdict(s, fixed, turn.text);
    turn.meta = { recommendation: s.verdict.recommendation, score: s.verdict.score };
    s.turns.push(turn);
    this.commit(s);
  }

  private buildVerdict(s: Session, m: Record<string, unknown>, speech: string): Verdict {
    const options = s.intake?.options ?? [];
    const scores = normalizeScores(m.scores, options);
    const best = [...scores].sort((a, b) => b.total - a.total)[0];
    const recommendation = this.optionId(s, m.recommendation) ?? best?.optionId ?? options[0]?.id ?? 'A';
    const strings = (v: unknown, max: number) =>
      (Array.isArray(v) ? v : []).map(x => asString(x, 400).trim()).filter(Boolean).slice(0, max);
    const attributed = (v: unknown): Attributed[] =>
      (Array.isArray(v) ? v : [])
        .map(x => (isRecord(x) ? { text: asString(x.text, 400).trim(), by: this.advisorRef(s, x.by) } : { text: asString(x, 400).trim(), by: '' }))
        .filter(x => x.text)
        .slice(0, 4);
    const confidence = m.confidence === 'low' || m.confidence === 'high' ? m.confidence : 'medium';
    return {
      recommendation,
      label: asString(m.label, 60).trim() || options.find(o => o.id === recommendation)?.label || recommendation,
      headline: asString(m.headline, 300).trim(),
      confidence,
      speech,
      score: scores.find(x => x.optionId === recommendation)?.total ?? 0,
      scores,
      tally: tally(s.ballots, options),
      strongestFor: attributed(m.strongest_for),
      strongestAgainst: attributed(m.strongest_against),
      conditions: strings(m.conditions, 6),
      risks: (Array.isArray(m.risks) ? m.risks : [])
        .filter(isRecord)
        .map(r => ({ risk: asString(r.risk, 300).trim(), mitigation: asString(r.mitigation, 300).trim() }))
        .filter(r => r.risk)
        .slice(0, 5),
      nextSteps: strings(m.next_steps, 6),
      wouldChange: strings(m.would_change, 4),
      dissent: asString(m.dissent, 400).trim(),
    };
  }
}
