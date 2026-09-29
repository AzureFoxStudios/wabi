/**
 * HTTP API + static web app. Plain node:http, no framework: the surface is
 * small (one command endpoint + read models) and this keeps the dependency
 * list empty.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { actorOf, isDemo, setup, DEMO_PASSWORD, type App } from './app.ts';
import { login, logout, userForToken, setPassword, verifyPassword } from './auth.ts';
import { CommandError } from './engine.ts';
import { storeBlob, openBlob, MAX_FILE_BYTES } from './files.ts';
import { addClient, broadcast } from './sse.ts';
import { readAll } from './journal.ts';
import { all, one, run } from './db.ts';
import * as Q from './queries.ts';
import { DEMO_USERS } from '@sabi/pack-sheet-metal';
import type { UserRecord } from './repo.ts';

const COOKIE = 'sabi_session';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

function errorOut(res: ServerResponse, e: unknown) {
  if (e instanceof CommandError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
  console.error(e);
  send(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server. The change was not saved.' } });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new CommandError(413, 'too_large', 'The upload is too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const ct = req.headers['content-type'] ?? '';
  // Requiring JSON blocks cross-site form posts (CSRF) in addition to SameSite cookies.
  if (!ct.includes('application/json')) throw new CommandError(415, 'json_required', 'Send JSON');
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new CommandError(400, 'bad_json', 'Malformed JSON');
  }
}

function tokenOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  // Fallback for GET-only resources a browser loads without custom headers (EventSource, <img>, downloads)
  // when cookies are unavailable, e.g. inside a third-party iframe with cookies blocked. Never for mutations.
  if ((req.method ?? 'GET') === 'GET') {
    const t = new URL(req.url ?? '/', 'http://localhost').searchParams.get('access_token');
    if (t) return t;
  }
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setCookie(res: ServerResponse, req: IncomingMessage, token: string | null) {
  // Over HTTPS use SameSite=None + Partitioned (CHIPS) so the app also works when embedded in an iframe
  // on another site (reverse-proxy previews, intranet portals). CSRF is still blocked: every mutation
  // must be JSON (forces a CORS preflight we never grant) and pass the Origin check below.
  const https = req.headers['x-forwarded-proto'] === 'https' || process.env.SABI_SECURE_COOKIE === '1';
  const attrs = https ? 'HttpOnly; Secure; SameSite=None; Partitioned' : 'HttpOnly; SameSite=Lax';
  res.setHeader('set-cookie', token
    ? `${COOKIE}=${encodeURIComponent(token)}; Path=/; ${attrs}; Max-Age=${30 * 86400}`
    : `${COOKIE}=; Path=/; ${attrs}; Max-Age=0`);
}

const loginAttempts = new Map<string, { n: number; until: number }>();
function throttle(ip: string) {
  const a = loginAttempts.get(ip);
  if (a && a.n >= 10 && a.until > Date.now()) throw new CommandError(429, 'slow_down', 'Too many attempts. Wait a minute and try again.');
}
function recordFailure(ip: string) {
  const a = loginAttempts.get(ip) ?? { n: 0, until: 0 };
  a.n += 1;
  a.until = Date.now() + 60_000;
  loginAttempts.set(ip, a);
}

export interface ServerOptions {
  staticDir?: string;
}

export function createHttpServer(app: App, opts: ServerOptions = {}) {
  app.listeners.add(broadcast);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const q = Object.fromEntries(url.searchParams) as Record<string, string>;

    if (!path.startsWith('/api/')) return serveStatic(req, res, path, opts.staticDir);

    // ── Public endpoints ──
    if (path === '/api/health') return send(res, 200, { ok: true });
    if (path === '/api/session' && method === 'GET') {
      const user = userForToken(app.db, tokenOf(req));
      const demo = isDemo(app);
      return send(res, 200, {
        user: user ?? null, setUp: app.isSetUp(), demo,
        demoAccounts: demo ? [{ username: 'owner', role: 'owner' }, ...DEMO_USERS.map((u) => ({ username: u.username, role: u.role, name: u.name }))] : undefined,
        demoPassword: demo ? DEMO_PASSWORD : undefined,
      });
    }
    if (path === '/api/setup' && method === 'POST') {
      const body = await readJson(req);
      const user = setup(app, body);
      const s = login(app.db, user.username, body.password)!;
      setCookie(res, req, s.token);
      return send(res, 200, { user: s.user, token: body.wantToken ? s.token : undefined });
    }
    if (path === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress ?? '?';
      throttle(ip);
      const body = await readJson(req);
      const s = login(app.db, String(body.username ?? ''), String(body.password ?? ''));
      if (!s) {
        recordFailure(ip);
        throw new CommandError(401, 'bad_credentials', 'Wrong username or password');
      }
      loginAttempts.delete(ip);
      setCookie(res, req, s.token);
      return send(res, 200, { user: s.user, token: body.wantToken ? s.token : undefined });
    }
    if (path === '/api/logout' && method === 'POST') {
      logout(app.db, tokenOf(req));
      setCookie(res, req, null);
      return send(res, 200, { ok: true });
    }

    // ── Authenticated ──
    const viewer = userForToken(app.db, tokenOf(req));
    if (!viewer) throw new CommandError(401, 'unauthenticated', 'Please sign in');
    const origin = req.headers.origin;
    if (method !== 'GET' && origin && req.headers.host && new URL(origin).host !== req.headers.host) {
      throw new CommandError(403, 'bad_origin', 'Cross-site request refused');
    }
    return routeAuthed(req, res, path, method, q, viewer);
  };

  const routeAuthed = async (req: IncomingMessage, res: ServerResponse, path: string, method: string, q: Record<string, string>, viewer: UserRecord) => {
    const ctx = app.ctx;
    const seg = path.split('/').filter(Boolean); // ['api', ...]
    const notFound = () => send(res, 404, { error: { code: 'not_found', message: 'Not found' } });

    if (method === 'POST' && seg[1] === 'commands' && seg[2]) {
      const input = await readJson(req);
      const out = app.exec(seg[2], input, actorOf(app, viewer.id));
      return send(res, 200, out);
    }
    if (method === 'POST' && path === '/api/files') {
      const subjectType = q.subjectType, subjectId = q.subjectId;
      const name = (q.name ?? 'file').slice(0, 255);
      const data = await readBody(req, MAX_FILE_BYTES);
      if (!data.length) throw new CommandError(400, 'empty', 'The file is empty');
      const sha = storeBlob(ctx.dataDir, data);
      const mime = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].slice(0, 120);
      const out = app.exec('file.attach', { subjectType, subjectId, sha256: sha, name, mime, size: data.length }, actorOf(app, viewer.id));
      return send(res, 200, out);
    }
    if (method === 'POST' && path === '/api/read') {
      const body = await readJson(req);
      const seq = one<{ s: number }>(app.db, 'SELECT COALESCE(MAX(seq),0) AS s FROM events')?.s ?? 0;
      run(app.db, 'INSERT INTO reads (user_id, subject_type, subject_id, seq) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET seq = excluded.seq',
        viewer.id, String(body.subjectType), String(body.subjectId), Math.min(Number(body.seq ?? seq), seq));
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/password') {
      const body = await readJson(req);
      const cred = one<{ password_hash: string }>(app.db, 'SELECT password_hash FROM credentials WHERE user_id = ?', viewer.id);
      const targetId = body.userId && body.userId !== viewer.id ? String(body.userId) : viewer.id;
      if (targetId !== viewer.id) {
        if (!ctx.pack.roles.find((r) => r.id === viewer.role)?.capabilities.includes('all')) throw new CommandError(403, 'forbidden', 'Only the owner can reset passwords');
      } else if (!cred || !verifyPassword(String(body.current ?? ''), cred.password_hash)) {
        throw new CommandError(400, 'bad_password', 'Current password is wrong', { field: 'current' });
      }
      if (String(body.password ?? '').length < 8) throw new CommandError(400, 'invalid', 'At least 8 characters', { field: 'password' });
      setPassword(app.db, targetId, String(body.password));
      return send(res, 200, { ok: true });
    }
    if (method !== 'GET') return notFound();

    switch (seg[1]) {
      case 'bootstrap':
        return send(res, 200, Q.bootstrap(ctx, viewer, isDemo(app)));
      case 'attention':
        return send(res, 200, Q.attention(ctx, viewer));
      case 'jobs':
        if (seg[2]) {
          const w = Q.jobWorkspace(ctx, seg[2], viewer);
          return w ? send(res, 200, w) : notFound();
        }
        return send(res, 200, Q.jobList(ctx, q, viewer));
      case 'documents':
        if (seg[2]) {
          const d = Q.documentView(ctx, seg[2], viewer);
          return d ? send(res, 200, d) : notFound();
        }
        return send(res, 200, Q.documentList(ctx, q));
      case 'parties':
        if (seg[2]) {
          const p = Q.partyView(ctx, seg[2]);
          return p ? send(res, 200, p) : notFound();
        }
        return send(res, 200, Q.partyList(ctx, q));
      case 'items':
        if (seg[2]) {
          const i = Q.itemView(ctx, seg[2]);
          return i ? send(res, 200, i) : notFound();
        }
        return send(res, 200, Q.itemList(ctx, q));
      case 'stock':
        return send(res, 200, { shortages: Q.shortages(app.db, ctx.pack), report: Q.stockReport(ctx) });
      case 'money':
        return send(res, 200, Q.moneyOverview(ctx));
      case 'reports': {
        const month = /^\d{4}-\d{2}$/.test(q.month ?? '') ? q.month : new Date().toISOString().slice(0, 7);
        if (seg[2] === 'vat-sales') return send(res, 200, Q.vatReport(ctx, 'sales', month));
        if (seg[2] === 'vat-purchases') return send(res, 200, Q.vatReport(ctx, 'purchase', month));
        if (seg[2] === 'wht') return send(res, 200, Q.whtReport(ctx, month));
        if (seg[2] === 'stock') return send(res, 200, Q.stockReport(ctx));
        if (seg[2] === 'trial-balance') return send(res, 200, Q.trialBalance(ctx, q.from, q.to));
        return notFound();
      }
      case 'activity':
        return send(res, 200, Q.activity(ctx, q));
      case 'search':
        return send(res, 200, Q.search(ctx, q.q ?? ''));
      case 'stream':
        return addClient(res, one<{ s: number }>(app.db, 'SELECT COALESCE(MAX(seq),0) AS s FROM events')?.s ?? 0);
      case 'files': {
        const f = one<{ sha256: string; name: string; mime: string }>(app.db, 'SELECT sha256, name, mime FROM files WHERE id = ?', seg[2] ?? '');
        const blob = f && openBlob(ctx.dataDir, f.sha256);
        if (!f || !blob) return notFound();
        const inline = /^(image\/|application\/pdf)/.test(f.mime) && q.download !== '1';
        res.writeHead(200, {
          'content-type': f.mime, 'content-length': blob.size, 'cache-control': 'private, max-age=31536000, immutable',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        });
        blob.stream().pipe(res);
        return;
      }
      case 'export': {
        if (!ctx.pack.roles.find((r) => r.id === viewer.role)?.capabilities.includes('all')) throw new CommandError(403, 'forbidden', 'Only the owner can export');
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="sabi-journal-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        });
        for (const e of readAll(app.db)) res.write(JSON.stringify(e) + '\n');
        res.end();
        return;
      }
      case 'users':
        return send(res, 200, all(app.db, 'SELECT id, name, username, role, locale, active, created_at FROM users ORDER BY created_at'));
      default:
        return notFound();
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) errorOut(res, e);
      else res.end();
    });
  });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string, dir?: string) {
  if (!dir || !existsSync(dir)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Sabi API is running. The web app is not built yet: run `npm run build` in sabi/.');
    return;
  }
  const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, safe);
  if (!file.startsWith(dir)) file = join(dir, 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const html = join(file, 'index.html');
    file = existsSync(html) ? html : existsSync(`${file}.html`) ? `${file}.html` : join(dir, 'index.html');
  }
  const ext = extname(file);
  const immutable = file.includes(`${join(dir, '_app', 'immutable')}`);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

