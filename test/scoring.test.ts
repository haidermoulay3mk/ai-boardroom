import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRITERIA, clampScore, normalizeScores, tally, weightedTotal } from '../src/scoring.ts';

const options = [
  { id: 'A', label: 'Do it', description: '' },
  { id: 'B', label: "Don't", description: '' },
];

test('criteria weights sum to 100', () => {
  assert.equal(CRITERIA.reduce((sum, c) => sum + c.weight, 0), 100);
});

test('weighted total maps 1-10 scores onto 10-100', () => {
  assert.equal(weightedTotal(Object.fromEntries(CRITERIA.map(c => [c.id, 10]))), 100);
  assert.equal(weightedTotal(Object.fromEntries(CRITERIA.map(c => [c.id, 1]))), 10);
  assert.equal(weightedTotal({}), 50);
});

test('clampScore rounds, clamps and falls back', () => {
  assert.equal(clampScore(7.6), 8);
  assert.equal(clampScore(42), 10);
  assert.equal(clampScore(-3), 1);
  assert.equal(clampScore('6'), 6);
  assert.equal(clampScore('n/a'), 5);
});

test('normalizeScores accepts criteria as an object or an array, matched by id or label', () => {
  const scores = normalizeScores(
    [
      { option: "Don't", criteria: [{ id: 'upside', score: 2, why: 'small' }] },
      { option: 'A', criteria: { upside: { score: 9, why: 'big' }, downside: 3 } },
    ],
    options,
  );
  assert.equal(scores[0]?.optionId, 'A');
  assert.equal(scores[0]?.criteria.find(c => c.id === 'upside')?.score, 9);
  assert.equal(scores[0]?.criteria.find(c => c.id === 'downside')?.score, 3);
  assert.equal(scores[1]?.criteria.find(c => c.id === 'upside')?.why, 'small');
  assert.equal(scores[1]?.criteria.length, CRITERIA.length);
});

test('tally counts only valid options', () => {
  const ballots = ['A', 'A', 'B', 'Z'].map((vote, i) => ({ advisorId: `x${i}`, vote, conviction: 5, reason: '', turnId: '' }));
  assert.deepEqual(tally(ballots, options), { A: 2, B: 1 });
});
