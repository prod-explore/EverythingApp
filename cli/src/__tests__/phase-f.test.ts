import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertStrongSecret, weakSecretReason } from '../secret-check.js';

const GOOD = '9f2b7c41d8e3a65b0c1f47d9a2e8b3c5';

describe('secret strength', () => {
  it('flags the placeholders shipped in .env.example, short and repetitive values', () => {
    for (const bad of ['change-me', 'your-secret-key-here', 'your-playwright-secret-key-here', 'your-server-auth-token-here', 'ci', 'password', 'x'.repeat(40), 'ab'.repeat(20)]) {
      assert.ok(weakSecretReason(bad), bad);
    }
    assert.equal(weakSecretReason(GOOD), null);
  });

  it('throws for weak secrets, skips unset ones, warns under ALLOW_WEAK_SECRETS', () => {
    assert.throws(() => assertStrongSecret('SERVER_AUTH_TOKEN', 'change-me', {}), /SERVER_AUTH_TOKEN is too weak/);
    assert.doesNotThrow(() => assertStrongSecret('SUPERVISOR_TOKEN', undefined, {}));
    assert.doesNotThrow(() => assertStrongSecret('SUPERVISOR_TOKEN', '', {}));
    assert.doesNotThrow(() => assertStrongSecret('X', GOOD, {}));
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (m: string) => { warned.push(m); };
    try {
      assertStrongSecret('X', 'change-me', { ALLOW_WEAK_SECRETS: 'true' });
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1);
  });
});
