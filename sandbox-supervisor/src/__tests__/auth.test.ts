import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxManager } from '../sandboxes.js';
import { createSupervisorApp } from '../api.js';
import { assertStrongSecret, weakSecretReason } from '../secret-check.js';
import { fakeOps } from './helpers.js';

const TOKEN = 'a3f1c9d27b6e4058a3f1c9d27b6e4058'; // gitleaks:allow — made-up fixture

describe('supervisor bearer auth', () => {
  let server: Server;
  let base: string;
  let mgr: SandboxManager;

  before(() => {
    mgr = new SandboxManager(fakeOps().ops);
    server = createSupervisorApp(mgr, 5000, { token: TOKEN }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await mgr.shutdown();
  });

  const claim = (headers: Record<string, string>) =>
    fetch(`${base}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ownerId: 'p1' }) });

  it('rejects requests without or with a wrong token', async () => {
    assert.equal((await claim({})).status, 401);
    assert.equal((await claim({ authorization: 'Bearer nope' })).status, 401);
    assert.equal((await fetch(`${base}/terminals?ownerId=p1`)).status, 401);
    assert.equal((await fetch(`${base}/sandboxes/p1/files?path=/workspace`)).status, 401);
  });

  it('accepts the right token', async () => {
    assert.equal((await claim({ authorization: `Bearer ${TOKEN}` })).status, 200);
  });

  it('keeps /health open for container health checks', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

describe('secret strength', () => {
  it('flags placeholders from .env.example, short and low-variety values', () => {
    for (const bad of ['change-me', 'your-secret-key-here', 'your-playwright-secret-key-here', 'your-server-auth-token-here', 'ci', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'abababababababababababababab']) {
      assert.ok(weakSecretReason(bad), bad);
    }
    assert.equal(weakSecretReason(TOKEN), null);
  });

  it('throws for a weak secret, ignores unset ones, warns under ALLOW_WEAK_SECRETS', () => {
    assert.throws(() => assertStrongSecret('X', 'change-me', {}), /X is too weak/);
    assert.doesNotThrow(() => assertStrongSecret('X', undefined, {}));
    assert.doesNotThrow(() => assertStrongSecret('X', TOKEN, {}));
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.doesNotThrow(() => assertStrongSecret('X', 'change-me', { ALLOW_WEAK_SECRETS: 'true' }));
    } finally {
      console.warn = warn;
    }
  });
});
