import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, UrlGuard, UrlBlockedError, isAllowedUrl, parseAllowHosts } from '../urlSafety.js';

describe('isPrivateAddress', () => {
  const privateCases = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:192.168.0.1', '64:ff9b::7f00:1', '2002:c0a8:0101::1', '[::1]',
  ];
  for (const ip of privateCases) {
    it(`blocks ${ip}`, () => assert.equal(isPrivateAddress(ip), true));
  }
  const publicCases = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.167.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'];
  for (const ip of publicCases) {
    it(`allows ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
  }
  it('fails closed on garbage', () => {
    assert.equal(isPrivateAddress('not-an-ip'), true);
    assert.equal(isPrivateAddress(''), true);
  });
});

function guard(map: Record<string, string[]>, allowHosts: string[] = []) {
  return new UrlGuard({ allowHosts, resolve: async h => { const r = map[h]; if (!r) throw new Error('NXDOMAIN'); return r; }, cacheTtlMs: 0 });
}

describe('UrlGuard.check', () => {
  const g = guard({
    'shop.example': ['93.184.216.34'],
    'rebind.example': ['93.184.216.34', '192.168.1.10'], // public + private = rebinding setup
    'lan.example': ['10.0.0.8'],
    'sandbox-mcp': ['172.18.0.5'], // a Docker service name
    'empty.example': [],
  });

  it('allows a normal public site', async () => { await g.check('https://shop.example/cart?x=1'); });
  it('allows public IP literals', async () => { await g.check('http://8.8.8.8/'); });

  const blocked: Array<[string, RegExp]> = [
    ['http://localhost:3000/', /private/],
    ['http://foo.localhost/', /private/],
    ['http://127.0.0.1/', /private/],
    ['http://2130706433/', /private/], // decimal form of 127.0.0.1
    ['http://0x7f.1/', /private/],
    ['http://017700000001/', /private/],
    ['http://[::1]:8080/', /private/],
    ['http://[::ffff:192.168.1.1]/', /private/],
    ['http://192.168.1.1/admin', /private/],
    ['http://169.254.169.254/latest/meta-data/', /private/],
    ['http://host.docker.internal:11434/', /private/],
    ['http://printer.local/', /private/],
    ['http://lan.example/', /private/],
    ['http://sandbox-mcp:3002/', /private/],
    ['http://rebind.example/', /private/],
    ['http://nxdomain.example/', /resolve/],
    ['http://empty.example/', /resolve/],
    ['file:///etc/passwd', /http/],
    ['ftp://shop.example/', /http/],
    ['javascript:alert(1)', /http/],
    ['not a url', /valid/],
  ];
  for (const [url, re] of blocked) {
    it(`blocks ${url}`, async () => {
      await assert.rejects(g.check(url), (e: unknown) => e instanceof UrlBlockedError && re.test(e.message));
    });
  }

  it('honours an explicit operator allowlist for private hosts', async () => {
    const allowed = guard({ 'nas.lan': ['192.168.1.20'] }, ['nas.lan', '192.168.1.30']);
    await allowed.check('http://nas.lan/');
    await allowed.check('http://192.168.1.30/');
    await assert.rejects(allowed.check('http://192.168.1.31/'), UrlBlockedError);
  });

  it('caches DNS answers for the TTL (no per-request lookup storm)', async () => {
    let lookups = 0;
    let t = 0;
    const cached = new UrlGuard({ resolve: async () => { lookups++; return ['93.184.216.34']; }, cacheTtlMs: 1000, now: () => t });
    await cached.check('https://shop.example/a');
    await cached.check('https://shop.example/b');
    assert.equal(lookups, 1);
    t = 1500;
    await cached.check('https://shop.example/c');
    assert.equal(lookups, 2);
  });
});

describe('helpers', () => {
  it('isAllowedUrl keeps the scheme allowlist', () => {
    assert.equal(isAllowedUrl('https://a.b'), true);
    assert.equal(isAllowedUrl('file:///x'), false);
  });
  it('parseAllowHosts trims and drops empties', () => {
    assert.deepEqual(parseAllowHosts(' a.lan, ,10.0.0.1 '), ['a.lan', '10.0.0.1']);
    assert.deepEqual(parseAllowHosts(undefined), []);
  });
});
