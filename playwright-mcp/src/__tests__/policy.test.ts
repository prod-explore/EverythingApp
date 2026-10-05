import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNavigation,
  checkRequest,
  hostMatchesPattern,
  isBlockedScheme,
  jsContextOptions,
  mergePolicy,
  normalizeHostPattern,
  parseJsPolicy,
  parsePatternList,
  policyOverrideSchema,
  strictestJs,
  OPEN_POLICY,
} from '../policy.js';

describe('hostMatchesPattern (glob)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['example.com', 'example.com', true],
    ['EXAMPLE.com.', 'example.com', true],
    ['www.example.com', 'example.com', false],
    ['www.example.com', '*.example.com', true],
    ['a.b.example.com', '*.example.com', true],
    ['example.com', '*.example.com', false],
    ['evilexample.com', '*.example.com', false],
    ['example.com.evil.net', '*.example.com', false],
    ['example.com.evil.net', 'example.com', false],
    ['shop-eu.example.com', 'shop-*.example.com', true],
    ['shop.eu.example.com', 'shop-*.example.com', false],
    ['api.shop-eu.example.com', '*.shop-*.example.com', true],
    ['anything.org', '*', true],
    ['example.com', 'https://example.com/path?q=1', true],
    ['example.com', 'example.com:8443', true],
    ['xn--bcher-kva.example', 'bücher.example', true],
    ['xn--bcher-kva.example', 'BÜCHER.example', true],
    ['example.com', '', false],
    ['examplexcom', 'example.com', false], // "." must be literal, not a regex wildcard
  ];
  for (const [host, pattern, expected] of cases) {
    it(`${host} ~ ${JSON.stringify(pattern)} → ${expected}`, () => assert.equal(hostMatchesPattern(host, pattern), expected));
  }
});

describe('normalizeHostPattern', () => {
  it('strips scheme, userinfo, port, path and trailing dot', () => {
    assert.equal(normalizeHostPattern('https://user@Example.COM:443/x'), 'example.com');
    assert.equal(normalizeHostPattern('example.com.'), 'example.com');
  });
  it('rejects empty and malformed patterns', () => {
    assert.equal(normalizeHostPattern('   '), null);
    assert.equal(normalizeHostPattern('a..b'), null);
  });
});

describe('isBlockedScheme', () => {
  for (const u of ['chrome://settings', 'chrome-extension://abc/x.html', 'file:///etc/passwd', 'devtools://devtools/x', 'view-source:https://a.b', 'javascript:alert(1)', 'FILE:///C:/x']) {
    it(`blocks ${u}`, () => assert.equal(isBlockedScheme(u), true));
  }
  for (const u of ['https://a.b', 'http://a.b', 'data:text/plain,hi', 'about:blank']) {
    it(`does not mark ${u}`, () => assert.equal(isBlockedScheme(u), false));
  }
});

describe('mergePolicy', () => {
  it('unions denylists and keeps each non-empty allowlist as a layer', () => {
    const p = mergePolicy({ domainAllow: ['*.corp.example'], domainDeny: ['bad.com'] }, { domainAllow: ['docs.corp.example'], domainDeny: ['worse.com', 'bad.com'] });
    assert.deepEqual(p.allowLayers, [['*.corp.example'], ['docs.corp.example']]);
    assert.deepEqual(p.deny.sort(), ['bad.com', 'worse.com']);
  });

  it('drops empty allowlists (empty = no restriction) and junk entries', () => {
    const p = mergePolicy({ domainAllow: [] }, { domainAllow: ['  ', ''] });
    assert.deepEqual(p.allowLayers, []);
  });

  it('picks the strictest JS policy', () => {
    assert.equal(mergePolicy({ js: 'allowed' }, { js: 'review' }).js, 'review');
    assert.equal(mergePolicy({ js: 'disabled' }, { js: 'allowed' }).js, 'disabled');
    assert.equal(mergePolicy({}, undefined).js, 'allowed');
  });

  it('strictestJs ordering', () => {
    assert.equal(strictestJs('review', 'disabled', 'allowed'), 'disabled');
    assert.equal(strictestJs(undefined, 'review'), 'review');
  });
});

describe('policy decisions', () => {
  const policy = mergePolicy({ domainDeny: ['*.tracker.net'] }, { domainAllow: ['example.com', '*.example.com'], domainDeny: ['ads.example.com'] });

  it('allows top-level navigation to an allowlisted domain', () => {
    assert.deepEqual(checkNavigation(policy, 'https://www.example.com/shop'), { allowed: true });
    assert.deepEqual(checkNavigation(policy, 'https://example.com/'), { allowed: true });
  });

  it('refuses navigation outside the allowlist with the user-facing message', () => {
    const d = checkNavigation(policy, 'https://other.org/x');
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.equal(d.code, 'not_allowlisted');
      assert.equal(d.reason, 'domain not allowed by project policy: other.org — ask the user to add it');
    }
  });

  it('deny wins over allow', () => {
    const d = checkNavigation(policy, 'https://ads.example.com/');
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.code, 'denied');
  });

  it('sub-resources ignore the allowlist but honour the denylist', () => {
    assert.deepEqual(checkRequest(policy, 'https://cdn.other.org/lib.js'), { allowed: true });
    const d = checkRequest(policy, 'https://px.tracker.net/p.gif');
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.match(d.reason, /denylist\): px\.tracker\.net/);
  });

  it('data:/blob: sub-resources pass', () => {
    assert.deepEqual(checkRequest(policy, 'data:image/png;base64,AAA'), { allowed: true });
  });

  it('blocks dangerous schemes for navigations and requests', () => {
    for (const u of ['chrome://settings', 'file:///etc/passwd', 'devtools://x', 'chrome-extension://id/a']) {
      const n = checkNavigation(OPEN_POLICY, u);
      const r = checkRequest(OPEN_POLICY, u);
      assert.equal(n.allowed, false, u);
      assert.equal(r.allowed, false, u);
      if (!n.allowed) assert.equal(n.code, 'scheme');
    }
  });

  it('rejects invalid URLs and non-http schemes', () => {
    const d = checkNavigation(OPEN_POLICY, 'not a url');
    assert.equal(d.allowed, false);
    assert.equal(checkNavigation(OPEN_POLICY, 'mailto:a@b.c').allowed, false);
  });

  it('an open policy allows any http(s) host', () => {
    assert.deepEqual(checkNavigation(OPEN_POLICY, 'https://anything.example/'), { allowed: true });
  });

  it('every allowlist layer must match (an override cannot widen the env allowlist)', () => {
    const p = mergePolicy({ domainAllow: ['*.corp.example'] }, { domainAllow: ['evil.com', 'wiki.corp.example'] });
    assert.equal(checkNavigation(p, 'https://evil.com/').allowed, false);
    assert.equal(checkNavigation(p, 'https://wiki.corp.example/').allowed, true);
    assert.equal(checkNavigation(p, 'https://hr.corp.example/').allowed, false);
  });
});

describe('JS policy → context options', () => {
  it('disabled turns JavaScript off', () => assert.deepEqual(jsContextOptions('disabled'), { javaScriptEnabled: false }));
  it('review runs JavaScript (results are marked)', () => assert.deepEqual(jsContextOptions('review'), { javaScriptEnabled: true }));
  it('allowed runs JavaScript', () => assert.deepEqual(jsContextOptions('allowed'), { javaScriptEnabled: true }));
});

describe('env parsing', () => {
  it('parseJsPolicy accepts the three values case-insensitively and falls back otherwise', () => {
    assert.equal(parseJsPolicy('DISABLED'), 'disabled');
    assert.equal(parseJsPolicy(' review '), 'review');
    assert.equal(parseJsPolicy('nope', 'review'), 'review');
    assert.equal(parseJsPolicy(undefined), 'allowed');
  });
  it('parsePatternList splits on commas and whitespace', () => {
    assert.deepEqual(parsePatternList('a.com, *.b.com  c.org,,'), ['a.com', '*.b.com', 'c.org']);
    assert.deepEqual(parsePatternList(undefined), []);
  });
});

describe('policyOverrideSchema (the hidden _policy arg)', () => {
  it('accepts a full override', () => {
    const r = policyOverrideSchema.safeParse({ domainAllow: ['a.com'], domainDeny: ['b.com'], js: 'review' });
    assert.equal(r.success, true);
  });
  it('rejects an unknown js value', () => {
    assert.equal(policyOverrideSchema.safeParse({ js: 'yolo' }).success, false);
  });
  it('strips unknown keys', () => {
    const r = policyOverrideSchema.parse({ js: 'allowed', extra: 1 } as unknown);
    assert.deepEqual(r, { js: 'allowed' });
  });
});
