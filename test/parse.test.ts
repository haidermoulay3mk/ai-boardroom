import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../src/advisors.ts';
import { cleanSpeech, extractJson, parseOutput } from '../src/parse.ts';

test('splits spoken words from the trailing meta block', () => {
  const out = parseOutput('Margin of safety first.\n<meta>{"leaning":"B","conviction":8}</meta>');
  assert.equal(out.speech, 'Margin of safety first.');
  assert.deepEqual(out.meta, { leaning: 'B', conviction: 8 });
});

test('tolerates a missing closing tag, code fences and trailing commas', () => {
  assert.deepEqual(parseOutput('Go.\n<meta>{"leaning":"A",}').meta, { leaning: 'A' });
  assert.deepEqual(parseOutput('Go.\n<meta>```json\n{"vote":"C"}\n```</meta>').meta, { vote: 'C' });
  assert.deepEqual(parseOutput('Words.\n```json\n{"vote":"A"}\n```').meta, { vote: 'A' });
});

test('returns null meta when there is none or it is not JSON', () => {
  assert.equal(parseOutput('Just talking.').meta, null);
  assert.equal(parseOutput('Talk <meta>not json</meta>').meta, null);
  assert.equal(extractJson('[1,2,3]'), null);
});

test('strips a leading speaker label but keeps names used mid-sentence', () => {
  assert.equal(cleanSpeech('Warren Buffett: Patience pays.', ['Warren Buffett', 'Warren']), 'Patience pays.');
  assert.equal(cleanSpeech('**Chair:** Let us begin.'), 'Let us begin.');
  assert.equal(cleanSpeech('Grant, you are wrong.', ['Warren Buffett', 'Warren']), 'Grant, you are wrong.');
  assert.equal(cleanSpeech('"Quoted whole reply."'), 'Quoted whole reply.');
});

test('parses advisor frontmatter, including quoted values and CRLF line endings', () => {
  const { data, body } = parseFrontmatter('---\r\nid: buffett\r\ncolor: "#2f7d5b"\r\nlens: a: b\r\n---\r\nHow you think: carefully.\r\n');
  assert.equal(data.id, 'buffett');
  assert.equal(data.color, '#2f7d5b');
  assert.equal(data.lens, 'a: b');
  assert.equal(body, 'How you think: carefully.');
});
