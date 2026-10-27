import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { InputError } from '../src/engine.ts';
import { DemoProvider } from '../src/providers/demo.ts';
import type { GenerateOptions, GenerateResult } from '../src/providers/types.ts';
import { renderMarkdown } from '../src/report-md.ts';
import { renderPdf } from '../src/report-pdf.ts';
import { Store } from '../src/store.ts';
import { cleanup, setup, tempDir, waitFor } from './helpers.ts';

after(cleanup);

const DECISION = 'Should I quit my job to work on my startup full time?';

class FlakyProvider extends DemoProvider {
  calls = 0;
  readonly failAt: number;
  constructor(failAt: number) {
    super(0);
    this.failAt = failAt;
  }
  override async generate(o: GenerateOptions): Promise<GenerateResult> {
    this.calls += 1;
    if (this.calls === this.failAt) throw new Error('Claude hit a usage limit.');
    return super.generate(o);
  }
}

test('a meeting runs from intake to a scored verdict, and is saved to disk', async () => {
  const { engine, store, dir } = setup();
  const created = engine.create({ decision: DECISION, provider: 'demo', depth: 'standard' });
  let s = await waitFor(() => store.get(created.id), x => x.status === 'awaiting_user');
  assert.equal(s.pending?.type, 'intake');
  assert.equal(s.intake?.options.length, 3);
  assert.ok((s.intake?.questions.length ?? 0) >= 2);

  engine.answer(s.id, { answers: { q1: 'Six months', q2: 'Three paying customers' } });
  s = await waitFor(() => store.get(created.id), x => x.status === 'done');

  const seated = s.input.advisors.length;
  assert.equal(seated, 8);
  assert.equal(s.turns.filter(t => t.kind === 'welcome').length, 1);
  assert.equal(s.turns.filter(t => t.kind === 'opening').length, seated);
  assert.equal(s.rounds.length, 2);
  assert.ok(s.turns.filter(t => t.kind === 'response').length >= 4);
  assert.equal(s.ballots.length, seated);
  assert.equal(s.intake?.answers?.q1, 'Six months');
  assert.ok(s.verdict);
  assert.equal(s.verdict.recommendation, 'C');
  assert.equal(s.verdict.scores.length, 3);
  assert.ok(s.verdict.score >= 10 && s.verdict.score <= 100);
  assert.equal(s.verdict.score, s.verdict.scores.find(x => x.optionId === 'C')?.total);
  assert.ok(s.verdict.nextSteps.length > 0);
  assert.ok(s.turns.every(t => !t.text.includes('<meta')), 'meta blocks never leak into the transcript');
  assert.ok(s.turns.filter(t => t.kind === 'opening').every(t => t.meta?.leaning), 'every opening records a leaning');

  await store.flush();
  const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${s.id}.json`), 'utf8'));
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.live, []);
  assert.equal(saved.turns.length, s.turns.length);
});

test('a failed turn stops the meeting, and Retry resumes without repeating finished turns', async () => {
  const { engine, store } = setup(new FlakyProvider(6));
  const created = engine.create({ decision: DECISION, provider: 'demo', depth: 'quick' });
  await waitFor(() => store.get(created.id), x => x.status === 'awaiting_user');
  engine.answer(created.id, { answers: {} });
  let s = await waitFor(() => store.get(created.id), x => x.status === 'error');
  assert.match(s.error ?? '', /usage limit/);
  const before = s.turns.length;
  assert.ok(before > 0);

  engine.resume(created.id);
  s = await waitFor(() => store.get(created.id), x => x.status === 'done');
  for (const id of s.input.advisors) assert.equal(s.turns.filter(t => t.speaker === id && t.kind === 'opening').length, 1);
  assert.equal(s.turns.filter(t => t.kind === 'welcome').length, 1);
  assert.ok(s.verdict);
});

test('the founder can raise a hand mid-meeting and gets the floor between speakers', async () => {
  const { engine, store } = setup(new DemoProvider(1));
  const created = engine.create({ decision: DECISION, provider: 'demo', depth: 'quick' });
  await waitFor(() => store.get(created.id), x => x.status === 'awaiting_user');
  engine.answer(created.id, { answers: {} });
  await waitFor(() => store.get(created.id), x => x.phase === 'opening' && x.turns.some(t => t.kind === 'opening'));
  engine.interject(created.id, { text: 'Note: I already have two investors interested.' });
  const s = await waitFor(() => store.get(created.id), x => x.status === 'done', 20000);
  const founder = s.turns.find(t => t.speaker === 'founder');
  assert.ok(founder);
  assert.equal(founder.text, 'Note: I already have two investors interested.');
  assert.deepEqual(s.queue, []);
});

test('adjourning cancels the meeting, and it can be resumed', async () => {
  const { engine, store } = setup(new DemoProvider(1));
  const created = engine.create({ decision: DECISION, provider: 'demo', depth: 'quick' });
  await waitFor(() => store.get(created.id), x => x.status === 'awaiting_user');
  engine.answer(created.id, { answers: {} });
  await waitFor(() => store.get(created.id), x => x.phase === 'opening');
  engine.cancel(created.id);
  let s = await waitFor(() => store.get(created.id), x => x.status === 'cancelled');
  assert.deepEqual(s.live, []);
  engine.resume(created.id);
  s = await waitFor(() => store.get(created.id), x => x.status === 'done', 20000);
  assert.ok(s.verdict);
});

test('input validation rejects bad requests', () => {
  const { engine } = setup();
  assert.throws(() => engine.create({ decision: 'hi' }), InputError);
  assert.throws(() => engine.create({ decision: DECISION, advisors: ['buffett'] }), InputError);
  assert.throws(() => engine.create({ decision: DECISION, model: 'sonnet; rm -rf /' }), InputError);
  assert.throws(() => engine.answer('20990101-000000-abcdef', {}), InputError);
});

test('reports render, including text the PDF fonts cannot draw', async () => {
  const { engine, store } = setup();
  const created = engine.create({ decision: `${DECISION} 🚀 هل أترك وظيفتي؟ “quotes” — dashes…`, provider: 'demo', depth: 'quick' });
  await waitFor(() => store.get(created.id), x => x.status === 'awaiting_user');
  engine.answer(created.id, { answers: {} });
  const s = await waitFor(() => store.get(created.id), x => x.status === 'done');
  const pdf = await renderPdf(s);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.length > 4000);
  const md = renderMarkdown(s);
  assert.match(md, new RegExp(`Verdict: ${s.verdict?.label}`));
  assert.match(md, /## Transcript/);
});

test('sessions that were running when the server stopped load as interrupted', () => {
  const dir = tempDir();
  const first = new Store(dir);
  const s = {
    id: '20261026-101010-abc123',
    version: 1,
    title: 't',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: { decision: DECISION, context: '', advisors: ['buffett', 'cardone'], depth: 'quick', model: 'sonnet', provider: 'demo' },
    cast: [],
    status: 'running',
    phase: 'opening',
    error: null,
    intake: null,
    turns: [],
    rounds: [],
    ballots: [],
    verdict: null,
    pending: null,
    queue: [],
    live: [{ id: 'x', speaker: 'buffett', kind: 'opening', text: 'half', startedAt: '' }],
    stats: { calls: 0 },
  };
  writeFileSync(join(first.dir, `${s.id}.json`), JSON.stringify(s));
  writeFileSync(join(first.dir, 'garbage.json'), '{not json');
  const second = new Store(dir);
  assert.equal(second.load(), 1);
  assert.equal(second.get(s.id)?.status, 'interrupted');
  assert.deepEqual(second.get(s.id)?.live, []);
  assert.equal(second.get('../../etc/passwd'), undefined);
});
