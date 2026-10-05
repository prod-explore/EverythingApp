import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromiumLaunchArgs,
  contextOptionsFor,
  decideRequest,
  drainEvents,
  handleDownload,
  handleFileChooser,
  newSessionState,
} from '../browserContext.js';
import { mergePolicy } from '../policy.js';
import { UrlBlockedError } from '../urlSafety.js';
import { applyCallPolicy, effectivePolicy, withDownloadPermission } from '../tools/policyArgs.js';
import { testConfig } from './testConfig.js';

describe('chromiumLaunchArgs', () => {
  const args = chromiumLaunchArgs();
  it('disables extensions and permission prompts', () => {
    for (const a of ['--disable-extensions', '--deny-permission-prompts', '--disable-notifications']) assert.ok(args.includes(a), a);
  });
  it('restricts WebRTC IP handling', () => {
    assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  });
  it('never passes a --disable-features flag (it would replace Playwright\'s own list)', () => {
    assert.equal(args.some(a => a.startsWith('--disable-features')), false);
  });
});

describe('contextOptionsFor', () => {
  it('maps JS policy to javaScriptEnabled', () => {
    assert.equal(contextOptionsFor(mergePolicy({ js: 'disabled' })).javaScriptEnabled, false);
    assert.equal(contextOptionsFor(mergePolicy({ js: 'review' })).javaScriptEnabled, true);
    assert.equal(contextOptionsFor(mergePolicy({ js: 'allowed' })).javaScriptEnabled, true);
  });
  it('is ephemeral and grants no permissions', () => {
    const o = contextOptionsFor(mergePolicy({}));
    assert.deepEqual(o.permissions, []);
    assert.equal(o.storageState, undefined);
    assert.equal(o.serviceWorkers, 'block');
  });
});

const okGuard = { check: async () => {} };
const privateGuard = {
  check: async (url: string) => {
    throw new UrlBlockedError(url, '"10.0.0.1" is on a private/internal network');
  },
};

describe('decideRequest (route interception)', () => {
  const state = newSessionState(mergePolicy({ domainDeny: ['ads.example'] }, { domainAllow: ['shop.example'] }));

  it('allows an allowlisted top-level navigation', async () => {
    assert.deepEqual(await decideRequest(state, okGuard, 'https://shop.example/', true), { allow: true });
  });
  it('blocks a top-level navigation outside the allowlist', async () => {
    const d = await decideRequest(state, okGuard, 'https://elsewhere.example/', true);
    assert.equal(d.allow, false);
    assert.match(d.reason!, /domain not allowed by project policy: elsewhere\.example — ask the user to add it/);
  });
  it('lets sub-resources from other domains through but blocks denied ones', async () => {
    assert.equal((await decideRequest(state, okGuard, 'https://cdn.elsewhere.example/x.js', false)).allow, true);
    assert.equal((await decideRequest(state, okGuard, 'https://ads.example/p.gif', false)).allow, false);
  });
  it('keeps the private-network SSRF guard in place for every request', async () => {
    const d = await decideRequest(state, privateGuard, 'https://shop.example/', true);
    assert.equal(d.allow, false);
    assert.match(d.reason!, /private/);
  });
  it('checks policy before the guard (no DNS lookup for a denied domain)', async () => {
    let called = false;
    const spy = { check: async () => { called = true; } };
    await decideRequest(state, spy, 'https://ads.example/', false);
    assert.equal(called, false);
  });
  it('reads the live session policy (updates apply to the next request)', async () => {
    const s = newSessionState(mergePolicy({}));
    assert.equal((await decideRequest(s, okGuard, 'https://x.example/', true)).allow, true);
    s.policy = mergePolicy({}, { domainDeny: ['x.example'] });
    assert.equal((await decideRequest(s, okGuard, 'https://x.example/', true)).allow, false);
  });
});

function fakeDownload(name = 'invoice.pdf') {
  const d = { cancelled: false, cancel: async () => { d.cancelled = true; }, suggestedFilename: () => name, url: () => 'https://x/y' };
  return d;
}

describe('downloads and uploads', () => {
  it('cancels downloads by default and records an event', () => {
    const state = newSessionState();
    const d = fakeDownload();
    handleDownload(state, d);
    assert.equal(d.cancelled, true);
    assert.match(drainEvents(state)[0]!, /download blocked: invoice\.pdf/);
    assert.deepEqual(drainEvents(state), []); // drained
  });

  it('keeps a download when the call carried _allow_downloads', async () => {
    const state = newSessionState();
    const d = fakeDownload();
    await withDownloadPermission(state, true, async () => handleDownload(state, d));
    assert.equal(d.cancelled, false);
    assert.match(state.events[0]!, /download allowed/);
    assert.equal(state.allowDownloads, false, 'permission is reset after the call');
  });

  it('resets download permission even when the call throws', async () => {
    const state = newSessionState();
    await assert.rejects(withDownloadPermission(state, true, async () => { throw new Error('boom'); }));
    assert.equal(state.allowDownloads, false);
  });

  it('sanitises download filenames in events', () => {
    const state = newSessionState();
    handleDownload(state, fakeDownload('../../evil\n<script>.exe'));
    assert.doesNotMatch(state.events[0]!, /[<>\n/]/);
  });

  it('records blocked file uploads', () => {
    const state = newSessionState();
    handleFileChooser(state);
    assert.match(state.events[0]!, /file upload blocked/);
  });
});

describe('per-call policy (_policy)', () => {
  it('env + override merge, sticky across calls that omit _policy', () => {
    const config = testConfig({ domainDeny: ['bad.example'], jsPolicy: 'review' });
    const state = newSessionState(effectivePolicy(config));
    applyCallPolicy(config, state, { domainAllow: ['good.example'], js: 'disabled' });
    assert.deepEqual(state.policy.allowLayers, [['good.example']]);
    assert.deepEqual(state.policy.deny, ['bad.example']);
    assert.equal(state.policy.js, 'disabled');
    applyCallPolicy(config, state, undefined);
    assert.deepEqual(state.policy.allowLayers, [['good.example']]);
  });

  it('an override cannot loosen the env JS policy', () => {
    const config = testConfig({ jsPolicy: 'disabled' });
    assert.equal(effectivePolicy(config, { js: 'allowed' }).js, 'disabled');
  });
});
