import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Request, RequestHandler, Router } from 'express';
import type { openDb } from './db.js';

type Db = ReturnType<typeof openDb>;

/**
 * Browser sessions: log in once with the server password, get an opaque random id in an
 * HttpOnly + SameSite=Strict cookie. Only the SHA-256 of the id is stored, so a leaked database
 * cannot be replayed as cookies. The old static bearer token keeps working for scripts and tests
 * (it is never stored in the browser any more).
 */

export const SESSION_COOKIE = 'ea_session';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_AFTER_MS = 60 * 60 * 1000; // sliding expiry, written at most hourly

export function migrateSessions(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash    TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      user_agent TEXT
    );
  `);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed value — ignore the cookie
    }
  }
  return out;
}

export class SessionStore {
  constructor(private readonly db: Db, private readonly ttlMs = DEFAULT_TTL_MS) {}

  create(userAgent?: string): string {
    const id = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id_hash, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(id), now, now + this.ttlMs, now, userAgent?.slice(0, 200) ?? null);
    return id;
  }

  verify(id: string | undefined): boolean {
    if (!id) return false;
    const hash = sha256(id);
    const row = this.db.prepare('SELECT expires_at, last_seen FROM sessions WHERE id_hash = ?').get(hash) as
      | { expires_at: number; last_seen: number }
      | undefined;
    if (!row) return false;
    const now = Date.now();
    if (row.expires_at <= now) {
      this.destroyHash(hash);
      return false;
    }
    if (now - row.last_seen > TOUCH_AFTER_MS) {
      this.db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?').run(now, now + this.ttlMs, hash);
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.destroyHash(sha256(id));
  }

  purgeExpired(): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes);
  }

  get ttl(): number {
    return this.ttlMs;
  }

  private destroyHash(hash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
  }
}

/** Failed-login throttle: at most `max` failures per `windowMs` per client, in memory (restart resets it). */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly max = 8, private readonly windowMs = 15 * 60 * 1000) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    this.failures.set(key, [...this.recent(key), Date.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter(t => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }
}

export interface AuthOptions {
  db: Db;
  /** Legacy shared secret — still accepted as `Authorization: Bearer` (scripts, tests). */
  authToken: string;
  /** What the login form checks. Defaults to authToken so existing setups keep their secret as the password. */
  password?: string;
  ttlMs?: number;
}

export interface Auth {
  sessions: SessionStore;
  /** POST /login, POST /logout, GET /session — mount BEFORE the auth middleware. */
  routes: Router;
  /** Gate for every other /api route: valid bearer token, or valid session cookie (+ same-origin check on writes). */
  middleware: RequestHandler;
  isBearerValid: (header: string | undefined) => boolean;
  isCookieValid: (cookieHeader: string | undefined) => boolean;
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function cookieHeader(value: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function createAuth(opts: AuthOptions): Auth {
  migrateSessions(opts.db);
  const sessions = new SessionStore(opts.db, opts.ttlMs);
  const limiter = new LoginLimiter();
  const password = opts.password ?? opts.authToken;
  sessions.purgeExpired();
  setInterval(() => sessions.purgeExpired(), 6 * 60 * 60 * 1000).unref();

  const isBearerValid = (header: string | undefined) => !!header && safeEqual(header, `Bearer ${opts.authToken}`);
  const isCookieValid = (cookies: string | undefined) => sessions.verify(parseCookies(cookies)[SESSION_COOKIE]);

  /** Cookie-authenticated writes must come from this origin — SameSite=Strict is the first line, this is the second. */
  function sameOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client, or a same-origin GET
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const routes = express.Router();

  routes.post('/login', (req, res) => {
    const key = req.ip ?? 'unknown';
    if (limiter.blocked(key)) {
      res.status(429).json({ error: 'too many failed attempts — try again in a few minutes' });
      return;
    }
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!supplied || !safeEqual(supplied, password)) {
      limiter.fail(key);
      res.status(401).json({ error: 'wrong password' });
      return;
    }
    limiter.reset(key);
    const id = sessions.create(req.headers['user-agent']);
    res.setHeader('Set-Cookie', cookieHeader(id, Math.floor(sessions.ttl / 1000), isSecureRequest(req)));
    res.json({ ok: true });
  });

  routes.post('/logout', (req, res) => {
    sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', cookieHeader('', 0, isSecureRequest(req)));
    res.json({ ok: true });
  });

  routes.get('/session', (req, res) => {
    if (isBearerValid(req.headers.authorization) || isCookieValid(req.headers.cookie)) res.json({ ok: true });
    else res.status(401).json({ error: 'unauthorized' });
  });

  const middleware: RequestHandler = (req, res, next) => {
    if (isBearerValid(req.headers.authorization)) return next();
    if (isCookieValid(req.headers.cookie)) {
      const safeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
      if (!safeMethod && !sameOrigin(req)) {
        res.status(403).json({ error: 'cross-origin request refused' });
        return;
      }
      return next();
    }
    res.status(401).json({ error: 'unauthorized' });
  };

  return { sessions, routes, middleware, isBearerValid, isCookieValid };
}
