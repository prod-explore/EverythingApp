import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { openDb, runMigrations } from '../db.js';
import { createAuth, parseCookies, LoginLimiter } from '../session.js';

let server: http.Server;
let base: string;

before(async () => {
  const db = openDb(':memory:');
  runMigrations(db);
  const auth = createAuth({ db, authToken: 'legacy-token', password: 'hunter2' });
  const app = express();
  app.use(express.json());
  app.use('/api', auth.routes);
  app.use('/api', auth.middleware);
  app.get('/api/secret', (_req, res) => res.json({ ok: true }));
  app.post('/api/secret', (_req, res) => res.json({ ok: true }));
  server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function login(password: string) {
  return fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
}

describe('session auth', () => {
  it('rejects anonymous requests', async () => {
    assert.equal((await fetch(`${base}/api/secret`)).status, 401);
  });

  it('rejects a wrong password', async () => {
    assert.equal((await login('nope')).status, 401);
  });

  it('login sets an HttpOnly SameSite=Strict cookie that authorizes requests; logout revokes it', async () => {
    const res = await login('hunter2');
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    assert.equal((await fetch(`${base}/api/secret`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 200);
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal((await fetch(`${base}/api/secret`, { headers: { Cookie: cookie } })).status, 401);
  });

  it('refuses cookie-authenticated writes from another origin', async () => {
    const cookie = (await login('hunter2')).headers.get('set-cookie')!.split(';')[0]!;
    const cross = await fetch(`${base}/api/secret`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const same = await fetch(`${base}/api/secret`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
    assert.equal(same.status, 200);
  });

  it('still accepts the legacy bearer token for scripts', async () => {
    assert.equal((await fetch(`${base}/api/secret`, { headers: { Authorization: 'Bearer legacy-token' } })).status, 200);
  });

  it('does not accept the legacy token as the login password unless it is the password', async () => {
    assert.equal((await login('legacy-token')).status, 401);
  });
});

describe('helpers', () => {
  it('parseCookies handles multiple cookies and bad encodings', () => {
    assert.deepEqual(parseCookies('a=1; ea_session=xyz; b=%E0%A4%A'), { a: '1', ea_session: 'xyz' });
  });

  it('LoginLimiter blocks after max failures', () => {
    const l = new LoginLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) l.fail('ip');
    assert.equal(l.blocked('ip'), true);
    l.reset('ip');
    assert.equal(l.blocked('ip'), false);
  });
});
