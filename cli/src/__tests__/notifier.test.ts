import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp } from '../server.js';
import { ProviderRouter } from '../providers/router.js';
import { openDb, runMigrations, listGazetaItems, createConversation } from '../db.js';
import { KeyVault } from '../providers/key-vault.js';
import { WebApprovalGate } from '../web-approval.js';
import {
  Notifier, buildPayload, buildRequest, detectFormat, loadNotifyConfig, normalizeWebhookUrl, saveNotifyConfig, NOTIFY_VAULT_KEY,
  type NotifyEvent,
} from '../notifier.js';

const TOKEN = 't';
const URL_SECRET = 'https://ntfy.example/very-secret-topic-123';
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const msg = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: '@t/m', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;

interface Sent { url: string; headers: Record<string, string>; body: string }
function recorder(status = 200) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response('ok', { status });
  }) as typeof fetch;
  return { sent, fetchImpl };
}
const now = (fn: () => void) => fn();

function notifier(env: NodeJS.ProcessEnv = {}, status = 200) {
  const db = openDb(':memory:');
  runMigrations(db);
  const vault = new KeyVault(db, 'k'.repeat(40));
  const rec = recorder(status);
  const n = new Notifier({ db, vault, env, fetchImpl: rec.fetchImpl, setTimer: now });
  return { db, vault, n, ...rec };
}
const settle = () => new Promise(r => setTimeout(r, 10));

describe('payloads', () => {
  const cfg = loadNotifyConfig(openDb(':memory:'));
  const ev: NotifyEvent = { kind: 'approval', ghost: false, chatTitle: 'Fix login', detail: 'sandbox__run_bash' };

  it('are minimal by default: no chat title, no tool', () => {
    const p = buildPayload({ ...cfg }, ev);
    assert.equal(p.title, 'Approval needed');
    assert.equal(p.message, 'An action is waiting for your approval.');
  });

  it('carry details only when asked, and never for a ghost chat', () => {
    assert.match(buildPayload({ ...cfg, details: true }, ev).message, /Fix login — sandbox__run_bash/);
    const ghost = buildPayload({ ...cfg, details: true }, { ...ev, ghost: true });
    assert.equal(ghost.message, 'Something is waiting in a private chat.');
    assert.ok(!JSON.stringify(ghost).includes('Fix login'));
  });

  it('urgent items get the top priority and the app link when set', () => {
    const p = buildPayload({ ...cfg, appUrl: 'https://ea.example' }, { kind: 'urgent', ghost: false });
    assert.equal(p.priority, 5);
    assert.equal(p.link, 'https://ea.example');
  });
});

describe('request formats', () => {
  const p = { title: 'Approval needed', message: 'An action is waiting.', priority: 4, link: 'https://ea.example' };

  it('auto picks Discord and Slack by host, plain text (ntfy) otherwise', () => {
    assert.equal(detectFormat('https://discord.com/api/webhooks/1/abc'), 'discord');
    assert.equal(detectFormat('https://hooks.slack.com/services/T/B/x'), 'slack');
    assert.equal(detectFormat('https://ntfy.sh/topic'), 'text');
    assert.equal(detectFormat('http://192.168.1.5:8080/alerts'), 'text');
  });

  it('text: message as the body, the rest as ntfy headers', () => {
    const r = buildRequest('https://ntfy.sh/t', 'auto', p);
    assert.equal(r.body, 'An action is waiting.');
    assert.deepEqual([r.headers['Title'], r.headers['Priority'], r.headers['Click']], ['Approval needed', '4', 'https://ea.example']);
  });

  it('text: a non-latin title cannot break the headers', () => {
    const r = buildRequest('https://ntfy.sh/t', 'text', { ...p, title: 'Zatwierdź — teraz' });
    assert.ok(/^[\x20-\x7e]*$/.test(r.headers['Title']!));
  });

  it('discord / slack / json bodies', () => {
    assert.match(JSON.parse(buildRequest('https://x.example/', 'discord', p).body).content, /Approval needed/);
    assert.deepEqual(JSON.parse(buildRequest('https://x.example/', 'discord', p).body).allowed_mentions, { parse: [] });
    assert.match(JSON.parse(buildRequest('https://x.example/', 'slack', p).body).text, /Approval needed/);
    assert.deepEqual(JSON.parse(buildRequest('https://x.example/', 'json', p).body), { title: 'Approval needed', message: 'An action is waiting.', priority: 4, link: 'https://ea.example' });
  });
});

describe('config', () => {
  it('rejects non-http URLs and junk', () => {
    assert.throws(() => normalizeWebhookUrl('ftp://x/y'), /http/);
    assert.throws(() => normalizeWebhookUrl('nope'), /valid URL/);
    assert.equal(normalizeWebhookUrl(' https://ntfy.sh/abc '), 'https://ntfy.sh/abc');
  });

  it('defaults on, merges patches, validates', () => {
    const { db } = notifier();
    const c = loadNotifyConfig(db);
    assert.deepEqual([c.format, c.details, c.delaySeconds, c.events], ['auto', false, 30, { approval: true, question: true, urgent: true }]);
    const next = saveNotifyConfig(db, { events: { approval: false } as never, appUrl: 'https://ea.example/' });
    assert.deepEqual([next.events.approval, next.events.question, next.appUrl], [false, true, 'https://ea.example']);
    assert.throws(() => saveNotifyConfig(db, { delaySeconds: -1 }), /delay/);
    assert.throws(() => saveNotifyConfig(db, { format: 'xml' as never }), /format/);
  });
});

describe('Notifier', () => {
  it('does nothing without a URL', async () => {
    const { n, sent } = notifier();
    n.notify({ kind: 'urgent', ghost: false });
    await settle();
    assert.equal(sent.length, 0);
  });

  it('sends to the vault URL, and falls back to NOTIFY_WEBHOOK_URL', async () => {
    const a = notifier();
    a.vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    a.n.notify({ kind: 'urgent', ghost: false });
    await settle();
    assert.equal(a.sent[0]!.url, URL_SECRET);

    const b = notifier({ NOTIFY_WEBHOOK_URL: 'http://ntfy:80/ea' });
    b.n.notify({ kind: 'urgent', ghost: false });
    await settle();
    assert.equal(b.sent[0]!.url, 'http://ntfy:80/ea');
  });

  it('respects the per-event switches', async () => {
    const { n, vault, db, sent } = notifier();
    vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    saveNotifyConfig(db, { events: { approval: false } as never });
    n.notify({ kind: 'approval', ghost: false });
    n.notify({ kind: 'question', ghost: false, detail: 'q' });
    await settle();
    assert.deepEqual(sent.map(s => s.headers['Title']), ['A question is waiting']);
  });

  it('skips what the user already dealt with during the delay', async () => {
    const { n, vault, sent } = notifier();
    vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    n.notify({ kind: 'approval', ghost: false, stillWaiting: () => false });
    await settle();
    assert.equal(sent.length, 0);
  });

  it('waits the configured delay for approvals and questions, not for urgent items', () => {
    const { db, vault } = notifier();
    vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    const delays: number[] = [];
    const rec = recorder();
    const n = new Notifier({ db, vault, fetchImpl: rec.fetchImpl, setTimer: (_f, ms) => void delays.push(ms) });
    n.notify({ kind: 'approval', ghost: false });
    n.notify({ kind: 'urgent', ghost: false });
    assert.deepEqual(delays, [30_000]);
    assert.equal(rec.sent.length, 1, 'urgent went out at once');
  });

  it('does not flood: the same event within 10 s is sent once', async () => {
    const { n, vault, sent } = notifier();
    vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    for (let i = 0; i < 5; i++) n.notify({ kind: 'question', ghost: false, detail: 'same', conversationId: 'c' });
    await settle();
    assert.equal(sent.length, 1);
  });

  it('a failing receiver is reported, never thrown at the caller', async () => {
    const { n, vault } = notifier({}, 500);
    vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    n.notify({ kind: 'urgent', ghost: false });
    await settle();
    assert.match(n.lastError ?? '', /answered 500/);
    await assert.rejects(n.send({ title: 't', message: 'm', priority: 3 }), /answered 500/);
  });

  it('describe() shows only the host of the URL, never the secret path', () => {
    const { n, vault } = notifier();
    vault.set(NOTIFY_VAULT_KEY, URL_SECRET);
    const d = n.describe();
    assert.equal(d.webhook.host, 'ntfy.example');
    assert.ok(!JSON.stringify(d).includes('very-secret-topic'));
  });
});

describe('approval gate hook', () => {
  it('fires when a call starts waiting for a human, and stillWaiting turns false once answered', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const conv = createConversation(db, { title: 'Chat', model: '@t/m' });
    const gate = new WebApprovalGate(db);
    const seen: Array<{ id: string; label: string }> = [];
    gate.onPending = e => seen.push({ id: e.id, label: e.toolLabel });
    const decision = gate.confirmDetailed(conv.id, 'sandbox__run_bash', { command: 'make deploy' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.label, 'sandbox__run_bash');
    assert.equal(gate.isPending(seen[0]!.id), true);
    gate.resolve(seen[0]!.id, true);
    assert.equal((await decision).approved, true);
    assert.equal(gate.isPending(seen[0]!.id), false);
  });
});

function api(port: number) {
  return (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function boot(script: (call: number) => Llm.Message, vaultSecret = 'v'.repeat(48)) {
  let call = 0;
  const client = {
    messages: {
      async create() { call++; return script(call); },
      batches: { create() { throw new Error('unused'); }, retrieve() { throw new Error('unused'); }, results() { throw new Error('unused'); } },
    },
  };
  const db = openDb(':memory:');
  runMigrations(db);
  const router = new ProviderRouter({ db, env: { KEY_VAULT_SECRET: vaultSecret } as NodeJS.ProcessEnv, llmOverride: client as any });
  router.catalog.create({ slug: 't', label: 'Test', baseUrl: 'https://t.example/v1', keyOptional: true });
  router.catalog.addManual('t', 'm', { tags: ['reasoning'] });
  const rec = recorder();
  const built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: '', autoApproveTools: [] }, notify: { fetchImpl: rec.fetchImpl, env: {}, setTimer: now } });
  const server = built.app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const call$ = api((server.address() as AddressInfo).port);
  return { db, built, server, call: call$, sent: rec.sent, close: () => { built.stop(); server.close(); db.close(); } };
}

describe('Settings → Notifications API', () => {
  it('saves the URL into the vault, never returns it, and reflects the settings', async () => {
    const t = await boot(() => msg([{ type: 'text', text: 'x', citations: null }], 'end_turn'));
    try {
      const empty = await t.call('GET', '/api/notifications');
      assert.equal(empty.json.webhook.present, false);
      assert.equal(empty.json.details, false);

      const saved = await t.call('PUT', '/api/notifications', { webhookUrl: URL_SECRET, details: true, events: { approval: false }, appUrl: 'https://ea.example/' });
      assert.equal(saved.status, 200);
      assert.deepEqual([saved.json.webhook.present, saved.json.webhook.host, saved.json.details, saved.json.events.approval, saved.json.appUrl], [true, 'ntfy.example', true, false, 'https://ea.example']);
      for (const path of ['/api/notifications', '/api/settings']) {
        assert.ok(!JSON.stringify((await t.call('GET', path)).json).includes('very-secret-topic'), `${path} leaked the URL`);
      }

      const kept = await t.call('PUT', '/api/notifications', { details: false });
      assert.equal(kept.json.webhook.present, true, 'absent webhookUrl leaves it alone');
      const gone = await t.call('PUT', '/api/notifications', { webhookUrl: null });
      assert.equal(gone.json.webhook.present, false);
    } finally { t.close(); }
  });

  it('refuses a bad URL, and a bad setting', async () => {
    const t = await boot(() => msg([{ type: 'text', text: 'x', citations: null }], 'end_turn'));
    try {
      assert.equal((await t.call('PUT', '/api/notifications', { webhookUrl: 'javascript:alert(1)' })).status, 400);
      assert.equal((await t.call('PUT', '/api/notifications', { delaySeconds: 99999 })).status, 400);
    } finally { t.close(); }
  });

  it('503 when the vault is off (KEY_VAULT_SECRET missing)', async () => {
    const t = await boot(() => msg([{ type: 'text', text: 'x', citations: null }], 'end_turn'), '');
    try {
      const r = await t.call('PUT', '/api/notifications', { webhookUrl: URL_SECRET });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /KEY_VAULT_SECRET/);
    } finally { t.close(); }
  });

  it('test sends to the typed URL without saving it, and reports a failure clearly', async () => {
    const t = await boot(() => msg([{ type: 'text', text: 'x', citations: null }], 'end_turn'));
    try {
      const ok = await t.call('POST', '/api/notifications/test', { webhookUrl: 'https://ntfy.example/typed' });
      assert.equal(ok.status, 200);
      assert.equal(t.sent[0]!.url, 'https://ntfy.example/typed');
      assert.equal((await t.call('GET', '/api/notifications')).json.webhook.present, false);

      const none = await t.call('POST', '/api/notifications/test', {});
      assert.equal(none.status, 400);
      assert.match(none.json.error, /No webhook URL/);
    } finally { t.close(); }
  });
});

describe('a question from the assistant', () => {
  it('goes out as a webhook with no chat content by default; an urgent one is marked as such', async () => {
    const t = await boot(call => call === 1
      ? msg([{ type: 'tool_use', id: 'u1', name: 'request_human_input', input: { title: 'Deploy to prod?', description: 'secret details', urgent: true } }], 'tool_use')
      : msg([{ type: 'text', text: 'ok', citations: null }], 'end_turn'));
    try {
      await t.call('PUT', '/api/notifications', { webhookUrl: URL_SECRET });
      const conv = (await t.call('POST', '/api/conversations', {})).json.id as string;
      await t.call('POST', `/api/conversations/${conv}/message`, { text: 'go' });
      const t0 = Date.now();
      while (listGazetaItems(t.db).length === 0 || t.sent.length === 0) {
        if (Date.now() - t0 > 3000) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 20));
      }
      assert.equal(t.sent[0]!.url, URL_SECRET);
      assert.equal(t.sent[0]!.headers['Title'], 'Urgent');
      assert.ok(!t.sent[0]!.body.includes('Deploy to prod') && !t.sent[0]!.body.includes('secret details'));
      await t.call('POST', `/api/gazeta/${listGazetaItems(t.db)[0]!.id}/respond`, { response: 'no' });
    } finally { t.close(); }
  });
});
