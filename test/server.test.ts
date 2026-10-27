import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { DemoProvider } from '../src/providers/demo.ts';
import { createApp, listen } from '../src/server.ts';
import { cleanup, tempDir } from './helpers.ts';

after(cleanup);

function rawStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function until(check: () => Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

test('HTTP API: guards, full session lifecycle, reports, static files', async () => {
  const demo = new DemoProvider(0);
  const app = createApp({ dataDir: tempDir(), demoOnly: true, providers: { demo, 'claude-code': demo } });
  const port = await listen(app.server, 0, '127.0.0.1', 0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const getJson = async (path: string): Promise<any> => (await fetch(base + path)).json();

  try {
    const health = await getJson('/api/health');
    assert.equal(health.app, 'Boardroom');
    assert.equal(health.defaultProvider, 'demo');
    assert.equal(health.criteria.length, 7);

    const advisors = await getJson('/api/advisors');
    assert.equal(advisors.advisors.length, 8);
    assert.equal(advisors.chair.id, 'chair');
    assert.ok(!('persona' in advisors.advisors[0]), 'persona prompts stay on the server');

    // Another website (or a DNS-rebinding page) must not be able to drive your Claude Code.
    assert.equal(await rawStatus(port, '/api/health', { Host: 'evil.example' }), 403);
    assert.equal((await post('/api/sessions', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await post('/api/sessions', { decision: 'hi' })).status, 400);

    const created = await post('/api/sessions', { decision: 'Should I raise my prices by forty percent?', depth: 'quick' });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    await until(async () => (await getJson(`/api/sessions/${id}`)).status === 'awaiting_user');
    assert.equal((await post(`/api/sessions/${id}/answer`, { answers: { q1: 'A year of runway' } })).status, 200);
    await until(async () => (await getJson(`/api/sessions/${id}`)).status === 'done');

    const pdf = await fetch(`${base}/api/sessions/${id}/report.pdf`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition') ?? '', /attachment; filename="boardroom-.+\.pdf"/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString('latin1'), '%PDF');
    assert.match(await (await fetch(`${base}/api/sessions/${id}/report.md`)).text(), /## Transcript/);

    const list = await getJson('/api/sessions');
    assert.equal(list[0].id, id);
    assert.equal(typeof list[0].score, 'number');

    const index = await fetch(`${base}/`);
    assert.match(await index.text(), /<title>Boardroom<\/title>/);
    assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.notEqual(await rawStatus(port, '/..%2f..%2fpackage.json'), 200);
    assert.equal((await fetch(`${base}/js/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');

    assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/sessions/${id}`)).status, 404);
  } finally {
    await app.close();
  }
});
