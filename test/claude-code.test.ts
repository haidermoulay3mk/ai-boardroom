import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ClaudeCodeProvider, friendlyError, resolveClaude } from '../src/providers/claude-code.ts';
import { AbortError } from '../src/providers/types.ts';
import { cleanup, tempDir } from './helpers.ts';

after(cleanup);

const fake = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const launch = { command: process.execPath, prefixArgs: [fake], shell: false };

test('streams text deltas from the CLI and resolves with the full reply', async () => {
  const provider = new ClaudeCodeProvider(launch);
  try {
    const deltas: string[] = [];
    const result = await provider.generate({ prompt: 'hello', model: 'sonnet', onText: d => deltas.push(d) });
    assert.equal(result.text, 'Hello from the fake CLI. <meta>{"leaning":"A","conviction":7}</meta>');
    assert.ok(deltas.length > 1);
    assert.equal(deltas.join(''), result.text);
    // The warm pool serves the next turn from an already-started process.
    const second = await provider.generate({ prompt: 'again', model: 'sonnet' });
    assert.match(second.text, /fake CLI/);
  } finally {
    provider.dispose();
  }
});

test('runs Claude Code isolated: no tools, no user settings, no MCP, no saved sessions', async () => {
  const provider = new ClaudeCodeProvider(launch);
  try {
    const { text } = await provider.generate({ prompt: 'ECHO_ARGS', model: 'opus' });
    const args = JSON.parse(text) as string[];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(after('--tools'), '');
    assert.equal(after('--setting-sources'), '');
    assert.equal(after('--model'), 'opus');
    assert.equal(after('--input-format'), 'stream-json');
    for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--include-partial-messages']) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
  } finally {
    provider.dispose();
  }
});

test('turns CLI errors into plain-language messages', async () => {
  const provider = new ClaudeCodeProvider(launch);
  try {
    await assert.rejects(provider.generate({ prompt: 'FAIL_AUTH', model: 'sonnet' }), /isn't signed in/);
  } finally {
    provider.dispose();
  }
  assert.match(friendlyError('Claude AI usage limit reached|1761500000'), /usage limit/);
  assert.match(friendlyError('model: claude-nope not found'), /isn't available/);
});

test('cancelling a turn kills the process', async () => {
  const provider = new ClaudeCodeProvider(launch);
  try {
    const controller = new AbortController();
    const pending = provider.generate({ prompt: 'HANG', model: 'sonnet', signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, AbortError);
  } finally {
    provider.dispose();
  }
});

test('health reports version and sign-in state without leaking the email', async () => {
  const provider = new ClaudeCodeProvider(launch);
  try {
    const health = await provider.health();
    assert.equal(health.ready, true);
    assert.equal(health.version, '9.9.9');
    assert.equal(health.plan, 'pro');
    assert.ok(!JSON.stringify(health).includes('example.com'));
  } finally {
    provider.dispose();
  }
  const missing = new ClaudeCodeProvider(null);
  assert.equal((await missing.health()).ready, false);
  await assert.rejects(missing.generate({ prompt: 'x', model: 'sonnet' }), /not found/);
  missing.dispose();
});

test('finds the real binary behind an npm .cmd shim on Windows, and plain claude elsewhere', () => {
  const dir = tempDir();
  const bin = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'claude.cmd'), '@echo off');
  writeFileSync(join(bin, 'claude.exe'), '');
  const win = resolveClaude('', dir, 'win32');
  assert.equal(win?.command, join(bin, 'claude.exe'));
  assert.equal(win?.shell, false);

  const posix = tempDir();
  writeFileSync(join(posix, 'claude'), '#!/bin/sh');
  assert.equal(resolveClaude('', posix, 'linux')?.command, join(posix, 'claude'));
  assert.equal(resolveClaude('C:\\tools\\claude.cmd', '', 'win32')?.shell, true);
});
