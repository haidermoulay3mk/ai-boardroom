import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Cast, loadCast, publicProfile } from './advisors.ts';
import { APP_NAME, config, DEPTHS, MODELS, ROOT } from './config.ts';
import { Engine, InputError } from './engine.ts';
import { Hub } from './hub.ts';
import { ClaudeCodeProvider } from './providers/claude-code.ts';
import { DemoProvider } from './providers/demo.ts';
import type { Provider, ProviderHealth } from './providers/types.ts';
import { renderMarkdown } from './report-md.ts';
import { renderPdf } from './report-pdf.ts';
import { CRITERIA } from './scoring.ts';
import { Store } from './store.ts';
import type { ProviderName, Session } from './types.ts';

const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface AppOptions {
  dataDir?: string;
  demoOnly?: boolean;
  providers?: Partial<Record<ProviderName, Provider>>;
}

export interface App {
  server: Server;
  engine: Engine;
  store: Store;
  cast: Cast;
  providers: Record<ProviderName, Provider>;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(opts: AppOptions = {}): App {
  const demoOnly = opts.demoOnly ?? config.demoOnly;
  const cast = loadCast(config.advisorsDir);
  const store = new Store(opts.dataDir ?? config.dataDir);
  store.load();
  const hub = new Hub();
  const providers: Record<ProviderName, Provider> = {
    'claude-code': opts.providers?.['claude-code'] ?? new ClaudeCodeProvider(),
    demo: opts.providers?.demo ?? new DemoProvider(),
  };
  const engine = new Engine({ store, hub, providers, cast, demoOnly });

  const claudeHealth = async (): Promise<ProviderHealth> =>
    demoOnly ? { name: 'claude-code', ready: false, detail: 'Boardroom was started in demo mode.' } : providers['claude-code'].health();

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET';

    if (path === '/api/health' && method === 'GET') {
      const claude = await claudeHealth();
      return json(res, 200, {
        app: APP_NAME,
        version: VERSION,
        demoOnly,
        defaultProvider: claude.ready ? 'claude-code' : 'demo',
        providers: { 'claude-code': claude, demo: await providers.demo.health() },
        models: MODELS,
        depths: DEPTHS,
        criteria: CRITERIA,
        dataDir: store.dir,
      });
    }
    if (path === '/api/advisors' && method === 'GET') {
      return json(res, 200, { chair: publicProfile(cast.chair), advisors: cast.advisors.map(publicProfile) });
    }
    if (path === '/api/warm' && method === 'POST') {
      const body = await readJson(req);
      const model = typeof body.model === 'string' && /^[\w.\-[\]]+$/.test(body.model) ? body.model : 'sonnet';
      if (!demoOnly) providers['claude-code'].prewarm(model, 1);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/sessions' && method === 'GET') return json(res, 200, store.list());
    if (path === '/api/sessions' && method === 'POST') {
      const s = engine.create(await readJson(req));
      return json(res, 201, { id: s.id });
    }

    const match = /^\/api\/sessions\/([a-z0-9-]+)(?:\/([a-z.]+))?$/.exec(path);
    if (!match) throw new HttpError(404, 'Not found.');
    const id = match[1] ?? '';
    const action = match[2] ?? '';
    const s = store.get(id);
    if (!s) throw new HttpError(404, 'Session not found.');

    if (!action && method === 'GET') return json(res, 200, s);
    if (!action && method === 'DELETE') {
      await engine.remove(id);
      return json(res, 200, { ok: true });
    }
    if (action === 'events' && method === 'GET') return events(req, res, s);
    if (method === 'POST') {
      const body = await readJson(req);
      if (action === 'answer') return json(res, 200, engine.answer(id, body));
      if (action === 'interject') return json(res, 200, engine.interject(id, body));
      if (action === 'cancel') return json(res, 200, engine.cancel(id));
      if (action === 'resume') return json(res, 200, engine.resume(id));
    }
    if (action === 'report.pdf' && method === 'GET') {
      const pdf = await renderPdf(s);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${query.has('inline') ? 'inline' : 'attachment'}; filename="${fileName(s, 'pdf')}"`,
        'Content-Length': pdf.length,
      });
      return void res.end(pdf);
    }
    if (action === 'report.md' && method === 'GET') {
      const md = Buffer.from(renderMarkdown(s), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName(s, 'md')}"`,
        'Content-Length': md.length,
      });
      return void res.end(md);
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  function events(req: IncomingMessage, res: ServerResponse, s: Session): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    hub.add(s.id, res);
    hub.sendTo(res, 'session', s);
    req.on('close', () => res.end());
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) throw new HttpError(403, 'Forbidden host.');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) throw new HttpError(403, 'Cross-origin request blocked.');
    if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname, url.searchParams);
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    return serveStatic(res, url.pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err instanceof HttpError ? err.status : err instanceof InputError ? 400 : 500;
      if (status === 500) console.error('[server]', err);
      if (res.headersSent) return void res.end();
      json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : (err as Error).message });
    });
  });

  return {
    server,
    engine,
    store,
    cast,
    providers,
    async close() {
      await engine.shutdown();
      hub.close();
      for (const p of Object.values(providers)) p.dispose();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

// ------------------------------------------------------------------ helpers

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid JSON body.');
}

/** Blocks DNS-rebinding: only answer requests addressed to this machine (unless HOST was opened up deliberately). */
function hostAllowed(req: IncomingMessage): boolean {
  if (!LOCAL_HOSTS.has(config.host) && config.host !== '127.0.0.1') return true;
  const host = req.headers.host ?? '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
  return LOCAL_HOSTS.has(name.toLowerCase());
}

/** Blocks other websites from driving your local Claude Code through this server. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path.');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = config.publicDir;
  const file = resolve(root, `.${rel}`);
  if (!file.startsWith(root + sep)) throw new HttpError(403, 'Forbidden.');
  let data: Buffer;
  let target = file;
  try {
    data = await readFile(file);
  } catch {
    if (extname(file)) throw new HttpError(404, 'Not found.');
    target = join(root, 'index.html');
    data = await readFile(target);
  }
  const type = MIME[extname(target)] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = CSP;
    headers['Referrer-Policy'] = 'no-referrer';
  }
  res.writeHead(200, headers);
  res.end(data);
}

function fileName(s: Session, ext: string): string {
  const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'decision';
  return `boardroom-${slug}-${s.createdAt.slice(0, 10)}.${ext}`;
}

export function listen(server: Server, port: number, host: string, attempts = 10): Promise<number> {
  return new Promise((done, fail) => {
    const tryPort = (p: number, left: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else fail(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        done(typeof address === 'object' && address ? address.port : p);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryPort(port, attempts);
  });
}

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed in the terminal anyway.
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const port = await listen(app.server, config.port, config.host);
  const url = `http://localhost:${port}`;
  const claude = config.demoOnly ? null : await app.providers['claude-code'].health();
  const status = !claude
    ? 'demo mode (scripted advisors, no AI calls)'
    : claude.ready
      ? `Claude Code ${claude.version ?? ''}${claude.plan ? ` · signed in (${claude.plan})` : ''}`
      : `Claude Code not ready: ${claude.detail} Demo mode still works.`;
  console.log(`\n  ${APP_NAME} is open  ->  ${url}\n  Engine: ${status}\n  Sessions are saved in ${app.store.dir}\n  Press Ctrl+C to stop.\n`);
  if (config.openBrowser) openBrowser(url);

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log('\n  Closing the boardroom...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
