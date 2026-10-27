import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { config } from '../config.ts';
import { ENGINE_SYSTEM } from '../prompts.ts';
import {
  AbortError,
  type GenerateOptions,
  type GenerateResult,
  type Provider,
  ProviderError,
  type ProviderHealth,
} from './types.ts';

/**
 * Runs every turn through the user's own Claude Code CLI (`claude -p`), so Boardroom
 * uses whatever plan they're signed in with and needs no API key of its own.
 *
 * `claude -p` spends several seconds booting, so we keep a small pool of processes
 * started in stream-json input mode: they finish booting while idle, and a turn only
 * pays for the model's first token.
 */

export interface Launch {
  command: string;
  prefixArgs: string[];
  shell: boolean;
}

const TIMEOUT_MS = 120_000;
const IDLE_MS = 4 * 60_000;
const MAX_PROCESSES = 8;

export function resolveClaude(explicit = config.claudePath, pathEnv = process.env.PATH ?? '', platform = process.platform): Launch | null {
  if (explicit) return { command: explicit, prefixArgs: [], shell: platform === 'win32' && /\.(cmd|bat)$/i.test(explicit) };
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  dirs.push(join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'));
  for (const dir of dirs) {
    if (platform === 'win32') {
      const exe = join(dir, 'claude.exe');
      if (existsSync(exe)) return { command: exe, prefixArgs: [], shell: false };
      const shim = join(dir, 'claude.cmd');
      if (existsSync(shim)) {
        // npm installs a .cmd shim; call the real binary behind it so no shell is involved.
        const pkg = join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
        const bin = join(pkg, 'bin', 'claude.exe');
        if (existsSync(bin)) return { command: bin, prefixArgs: [], shell: false };
        const cli = join(pkg, 'cli.js');
        if (existsSync(cli)) return { command: process.execPath, prefixArgs: [cli], shell: false };
        return { command: shim, prefixArgs: [], shell: true };
      }
    } else {
      const bin = join(dir, 'claude');
      if (existsSync(bin)) return { command: bin, prefixArgs: [], shell: false };
    }
  }
  return null;
}

/** Quote for cmd.exe. Only used in the rare .cmd-shim fallback; prompts never travel as arguments. */
const quote = (arg: string): string => (/^[\w\-.:\\/=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE; // set when Boardroom itself is launched from inside Claude Code
  return env;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: Array<{ type?: string; text?: string }> };
  is_error?: boolean;
  result?: unknown;
  error?: string;
  retry_delay_ms?: number;
}

class ClaudeProcess {
  readonly child: ChildProcess;
  exited = false;
  exitCode: number | null = null;
  stderr = '';
  onEvent: ((event: StreamEvent) => void) | null = null;
  onExit: (() => void) | null = null;
  private buffer = '';

  constructor(launch: Launch, args: string[], cwd: string) {
    const all = [...launch.prefixArgs, ...args];
    const options = { cwd, env: childEnv(), windowsHide: true, stdio: 'pipe' as const };
    this.child = launch.shell
      ? spawn([quote(launch.command), ...all.map(quote)].join(' '), { ...options, shell: true })
      : spawn(launch.command, all, options);
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.stdin?.on('error', () => {});
    this.child.on('error', err => {
      this.stderr += `\n${err.message}`;
      this.markExited(null);
    });
    this.child.on('exit', code => this.markExited(code));
  }

  send(prompt: string): void {
    this.child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  }

  /** Close stdin so the process exits on its own; kill it if it lingers. */
  release(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    setTimeout(() => this.kill(), 20_000).unref();
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }

  private markExited(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.onExit?.();
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onEvent?.(JSON.parse(line) as StreamEvent);
      } catch {
        // not JSON (a warning line); ignore
      }
    }
  }
}

const SIGN_IN = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth/i;
const LIMIT = /usage limit|limit reached|rate limit|too many requests|credit balance|quota/i;

export function friendlyError(text: string): string {
  const t = text.trim().slice(0, 500);
  if (SIGN_IN.test(t)) return "Claude Code isn't signed in. Run `claude` in a terminal, sign in, then press Retry.";
  if (LIMIT.test(t)) return `Claude hit a usage limit: "${t}". Wait for it to reset or pick a lighter model, then press Retry.`;
  if (/model/i.test(t) && /not found|invalid|not available|unknown/i.test(t)) {
    return `That model isn't available on your plan ("${t}"). Pick another model.`;
  }
  return t || 'Claude Code returned an error.';
}

/** Short CLI messages that arrive as plain text instead of a streamed model reply. */
const looksLikeCliError = (text: string): boolean => text.length < 400 && (SIGN_IN.test(text) || LIMIT.test(text));

function exitMessage(proc: ClaudeProcess): string {
  const tail = proc.stderr.trim().split('\n').slice(-4).join(' ').slice(-400);
  return friendlyError(tail || `Claude Code exited unexpectedly (code ${proc.exitCode ?? 'unknown'}).`);
}

export class ClaudeCodeProvider implements Provider {
  readonly name = 'claude-code' as const;
  private readonly launch: Launch | null;
  private readonly workDir: string;
  private readonly systemPromptFile: string;
  private readonly settingsFile: string;
  private readonly pool = new Map<string, ClaudeProcess[]>();
  private readonly active = new Set<ClaudeProcess>();
  private readonly reaper: NodeJS.Timeout;
  private lastUse = 0;
  private healthCache: { at: number; value: ProviderHealth } | null = null;

  constructor(launch: Launch | null = resolveClaude()) {
    this.launch = launch;
    // An empty working directory, so no project CLAUDE.md, hooks or .mcp.json get picked up.
    this.workDir = join(tmpdir(), 'boardroom-claude');
    mkdirSync(this.workDir, { recursive: true });
    this.systemPromptFile = join(this.workDir, 'system-prompt.txt');
    this.settingsFile = join(this.workDir, 'settings.json');
    writeFileSync(this.systemPromptFile, ENGINE_SYSTEM);
    writeFileSync(this.settingsFile, JSON.stringify({ alwaysThinkingEnabled: false }));
    this.reaper = setInterval(() => this.reap(), 30_000);
    this.reaper.unref();
  }

  private args(model: string): string[] {
    return [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
      '--system-prompt-file', this.systemPromptFile,
      '--settings', this.settingsFile,
      // Isolation: no user/project settings (so no plugins or hooks), no MCP servers,
      // no skills, no tools, and nothing written to the user's session history.
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--tools', '',
      '--no-session-persistence',
      ...config.claudeExtraArgs,
    ];
  }

  private spawnProcess(model: string): ClaudeProcess {
    if (!this.launch) {
      throw new ProviderError('Claude Code was not found. Install it, run `claude` once to sign in, then restart Boardroom.');
    }
    return new ClaudeProcess(this.launch, this.args(model), this.workDir);
  }

  private pooledCount(): number {
    let n = 0;
    for (const list of this.pool.values()) n += list.filter(p => !p.exited).length;
    return n;
  }

  prewarm(model: string, count = config.warmPoolSize): void {
    if (!this.launch) return;
    this.lastUse = Date.now();
    const list = (this.pool.get(model) ?? []).filter(p => !p.exited);
    while (list.length < count && this.pooledCount() + list.length + this.active.size < MAX_PROCESSES) {
      list.push(this.spawnProcess(model));
    }
    this.pool.set(model, list);
  }

  private acquire(model: string): ClaudeProcess {
    const list = this.pool.get(model) ?? [];
    let proc = list.shift();
    while (proc?.exited) proc = list.shift();
    this.pool.set(model, list);
    return proc ?? this.spawnProcess(model);
  }

  generate(o: GenerateOptions): Promise<GenerateResult> {
    if (o.signal?.aborted) return Promise.reject(new AbortError());
    let proc: ClaudeProcess;
    try {
      proc = this.acquire(o.model);
    } catch (err) {
      return Promise.reject(err);
    }
    this.active.add(proc);
    this.prewarm(o.model); // top the pool back up while this turn runs

    return new Promise<GenerateResult>((resolve, reject) => {
      let text = '';
      let streamed = false;
      let settled = false;
      let watchdog: NodeJS.Timeout | undefined;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        o.signal?.removeEventListener('abort', onAbort);
        proc.onEvent = null;
        proc.onExit = null;
        this.active.delete(proc);
        this.lastUse = Date.now();
        proc.release();
        if (err) reject(err);
        else resolve({ text });
      };
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          proc.kill();
          finish(new ProviderError(`Claude Code stopped responding for ${TIMEOUT_MS / 1000} seconds.`));
        }, TIMEOUT_MS);
      };
      const onAbort = () => {
        proc.kill();
        finish(new AbortError());
      };

      proc.onEvent = ev => {
        arm();
        if (ev.type === 'stream_event') {
          const e = ev.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
            streamed = true;
            text += e.delta.text;
            o.onText?.(e.delta.text);
          } else if (e?.type === 'message_stop' && streamed) {
            finish(); // don't wait the extra second for the result summary
          }
        } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
          const wait = Math.round((ev.retry_delay_ms ?? 0) / 1000);
          o.onStatus?.(`Claude is busy (${ev.error ?? 'retrying'}). Trying again in ${wait}s…`);
        } else if (ev.type === 'assistant' && !streamed) {
          const t = (ev.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
          if (t) text = t;
        } else if (ev.type === 'result') {
          const resultText = typeof ev.result === 'string' ? ev.result : '';
          if (ev.is_error || ev.subtype !== 'success') finish(new ProviderError(friendlyError(resultText || String(ev.subtype))));
          else if (!streamed && looksLikeCliError(text || resultText)) finish(new ProviderError(friendlyError(text || resultText)));
          else {
            if (!text) text = resultText;
            finish();
          }
        }
      };
      proc.onExit = () => finish(new ProviderError(exitMessage(proc)));
      o.signal?.addEventListener('abort', onAbort, { once: true });

      if (proc.exited) {
        finish(new ProviderError(exitMessage(proc)));
        return;
      }
      arm();
      proc.send(o.prompt);
    });
  }

  async health(): Promise<ProviderHealth> {
    if (this.healthCache && Date.now() - this.healthCache.at < 30_000) return this.healthCache.value;
    let value: ProviderHealth;
    if (!this.launch) {
      value = { name: this.name, ready: false, detail: 'Claude Code CLI not found on this machine.' };
    } else {
      const version = (await this.exec(['--version']).catch(() => '')).trim();
      let auth: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
      try {
        auth = JSON.parse(await this.exec(['auth', 'status', '--json']));
      } catch {
        // older CLI without `auth status`; the first call will surface sign-in problems
      }
      const ready = Boolean(version) && auth.loggedIn !== false;
      value = {
        name: this.name,
        ready,
        version: version.split(' ')[0] || null,
        loggedIn: auth.loggedIn ?? null,
        plan: auth.subscriptionType ?? null,
        authMethod: auth.authMethod ?? null,
        detail: !version
          ? 'Found Claude Code but could not run it.'
          : auth.loggedIn === false
            ? 'Claude Code is installed but not signed in. Run `claude` once to sign in.'
            : 'Ready.',
      };
    }
    this.healthCache = { at: Date.now(), value };
    return value;
  }

  private exec(args: string[]): Promise<string> {
    const launch = this.launch;
    if (!launch) return Promise.reject(new Error('not installed'));
    const command = launch.shell ? quote(launch.command) : launch.command;
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...launch.prefixArgs, ...args],
        { timeout: 15_000, windowsHide: true, env: childEnv(), shell: launch.shell },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }

  private reap(): void {
    if (this.active.size || Date.now() - this.lastUse < IDLE_MS) return;
    for (const list of this.pool.values()) for (const p of list) p.kill();
    this.pool.clear();
  }

  dispose(): void {
    clearInterval(this.reaper);
    for (const list of this.pool.values()) for (const p of list) p.kill();
    for (const p of this.active) p.kill();
    this.pool.clear();
    this.active.clear();
  }
}
