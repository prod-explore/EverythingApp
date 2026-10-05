import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ADMIN, basic, decodePkts, harness, readBody, receivePackBody, sha, ZERO, type Harness } from './helpers.js';
import { FLUSH_PKT } from '../pktline.js';

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: opts.headers, agent: false }, res => {
      readBody(res as unknown as http.IncomingMessage).then(body => resolve({ status: res.statusCode!, headers: res.headers, body }), reject);
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const RP_HEADERS = { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' };

/** Extracts report-status lines from a (possibly side-band) receive-pack result. */
function reportLines(body: Buffer): string[] {
  const pkts = decodePkts(body);
  const band1 = pkts.filter(p => p && p[0] === 1);
  const inner = band1.length ? decodePkts(Buffer.concat(band1.map(p => p!.subarray(1)))) : pkts;
  return inner.filter((p): p is Buffer => p !== null).map(p => p.toString().trimEnd());
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('admin API', () => {
  it('requires the admin token, mints and revokes', async () => {
    h = await harness();
    const unauth = await request(`${h.proxy}/admin/tokens`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong' } });
    assert.equal(unauth.status, 401);

    const auth = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
    const bad = await request(`${h.proxy}/admin/tokens`, { method: 'POST', headers: auth, body: JSON.stringify({ projectId: 'p', repos: [{ owner: 'a', repo: 'b', pushMode: 'yolo' }] }) });
    assert.equal(bad.status, 400);

    const ok = await request(`${h.proxy}/admin/tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'p9', repos: [{ owner: 'acme', repo: 'app', pushMode: 'allow' }], ttlSeconds: 120 }),
    });
    assert.equal(ok.status, 201);
    const { token, expiresAt } = JSON.parse(ok.body.toString());
    assert.ok(token && Date.parse(expiresAt) > Date.now());
    assert.equal(h.tokens.verify(token)?.projectId, 'p9');

    const del = await request(`${h.proxy}/admin/tokens/${encodeURIComponent(token)}`, { method: 'DELETE', headers: auth });
    assert.equal(del.status, 204);
    assert.equal(h.tokens.verify(token), null);

    const health = await request(`${h.proxy}/health`);
    assert.equal(health.status, 200);
  });
});

describe('auth and repo binding', () => {
  it('no credentials -> 401 with a Basic challenge (so git sends the URL credentials)', async () => {
    h = await harness();
    const r = await request(`${h.proxy}/acme/app.git/info/refs?service=git-upload-pack`);
    assert.equal(r.status, 401);
    assert.match(String(r.headers['www-authenticate']), /^Basic /);
    assert.equal(h.upstreamSeen.length, 0);
  });

  it('repo not bound to the token -> 403 with a git-friendly text message, upstream untouched', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'acme', repo: 'app' }]);
    const r = await request(`${h.proxy}/acme/secret.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic(token) } });
    assert.equal(r.status, 403);
    assert.match(String(r.headers['content-type']), /^text\/plain/);
    assert.match(r.body.toString(), /acme\/secret is not linked to this project/);
    const r2 = await request(`${h.proxy}/acme/secret/git-upload-pack`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '0000' });
    assert.equal(r2.status, 403);
    assert.equal(h.upstreamSeen.length, 0);
  });

  it('expired token -> 401', async () => {
    let now = Date.now();
    h = await harness({ now: () => now });
    const token = h.mint([{ owner: 'acme', repo: 'app' }], 60);
    const ok = await request(`${h.proxy}/acme/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic(token) } });
    assert.equal(ok.status, 200);
    now += 61_000;
    const r = await request(`${h.proxy}/acme/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic(token) } });
    assert.equal(r.status, 401);
    assert.match(r.body.toString(), /invalid or expired/);
    assert.equal(h.upstreamSeen.length, 1);
  });
});

describe('credential injection', () => {
  it('replaces the client Authorization with the project GitHub token; strips cookies; keeps path/query', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'Acme', repo: 'App' }]);
    const r = await request(`${h.proxy}/acme/app/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic(token), cookie: 'session=leak', 'git-protocol': 'version=2', 'user-agent': 'git/2.45' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'upstream-ok');
    const seen = h.upstreamSeen[0]!;
    assert.equal(seen.url, '/acme/app.git/info/refs?service=git-upload-pack');
    assert.equal(seen.headers.authorization, `Basic ${Buffer.from('x-access-token:ghs_proj1').toString('base64')}`);
    assert.ok(!JSON.stringify(seen.headers).includes(token), 'proxy token must not reach GitHub');
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers['git-protocol'], 'version=2');
    // Request audit line without secrets
    const lines = h.auditLines.map(l => JSON.parse(l));
    const reqLine = lines.find(l => l.type === 'request');
    assert.equal(reqLine.projectId, 'proj1');
    assert.equal(reqLine.status, 200);
    assert.ok(!h.auditLines.join('').includes(token));
    assert.ok(!h.auditLines.join('').includes('ghs_proj1'));
  });

  it('falls back to GITHUB_PAT when the orchestrator has no token', async () => {
    h = await harness({ fallbackPat: 'ghp_fallback', githubToken: (_p, res) => res.writeHead(404).end() });
    const token = h.mint([{ owner: 'acme', repo: 'app' }]);
    const r = await request(`${h.proxy}/acme/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic(token) } });
    assert.equal(r.status, 200);
    assert.equal(h.upstreamSeen[0]!.headers.authorization, `Basic ${Buffer.from('x-access-token:ghp_fallback').toString('base64')}`);
  });

  it('no credentials at all -> 503, nothing sent upstream', async () => {
    h = await harness({ githubToken: (_p, res) => res.writeHead(404).end() });
    const token = h.mint([{ owner: 'acme', repo: 'app' }]);
    const r = await request(`${h.proxy}/acme/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic(token) } });
    assert.equal(r.status, 503);
    assert.equal(h.upstreamSeen.length, 0);
  });
});

describe('upload-pack streaming', () => {
  it('streams the response before upstream finishes and the request body byte-for-byte', async () => {
    let releaseUpstream!: () => void;
    const released = new Promise<void>(r => (releaseUpstream = r));
    let upstreamBodyHash = '';
    h = await harness({
      upstream: async (req, res) => {
        const body = await readBody(req);
        upstreamBodyHash = createHash('sha256').update(body).digest('hex');
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.write('first-chunk;');
        await released; // only continues once the client has seen the first chunk
        res.end('second-chunk');
      },
    });
    const token = h.mint([{ owner: 'acme', repo: 'app' }]);
    const reqBody = randomBytes(3 * 1024 * 1024);
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.request(`${h!.proxy}/acme/app.git/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: basic(token), 'content-type': 'application/x-git-upload-pack-request' },
        agent: false,
      });
      req.on('response', res => {
        let text = '';
        res.on('data', (c: Buffer) => {
          text += c.toString();
          if (text.includes('first-chunk;')) releaseUpstream();
        });
        res.on('end', () => resolve(text));
        res.on('error', reject);
      });
      req.on('error', reject);
      // chunked upload, like git does for large requests
      for (let i = 0; i < reqBody.length; i += 256 * 1024) req.write(reqBody.subarray(i, i + 256 * 1024));
      req.end();
    });
    assert.equal(got, 'first-chunk;second-chunk');
    assert.equal(upstreamBodyHash, createHash('sha256').update(reqBody).digest('hex'));
  });

  it('passes gzip-encoded upload-pack requests through unchanged', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'acme', repo: 'app' }]);
    const gz = gzipSync(Buffer.from('0032want aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n00000009done\n'));
    const r = await request(`${h.proxy}/acme/app.git/git-upload-pack`, { method: 'POST', headers: { authorization: basic(token), 'content-encoding': 'gzip' }, body: gz });
    assert.equal(r.status, 200);
    assert.equal(h.upstreamSeen[0]!.headers['content-encoding'], 'gzip');
    assert.ok(h.upstreamSeen[0]!.body.equals(gz));
  });
});

describe('receive-pack approval', () => {
  const pack = Buffer.from('PACK\x00\x00\x00\x02fake-pack-bytes');

  it('ask + approved -> forwarded with the exact bytes; orchestrator got the classified refs', async () => {
    h = await harness({ pushApproval: (_b, _req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":true}'), 50) });
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const body = receivePackBody([{ old: ZERO, new: sha('b'), ref: 'refs/heads/feature' }], undefined, pack);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'upstream-ok');
    assert.ok(h.upstreamSeen[0]!.body.equals(body));
    assert.equal(h.upstreamSeen[0]!.url, '/acme/app.git/git-receive-pack');
    assert.deepEqual(h.approvals, [
      { projectId: 'proj1', owner: 'acme', repo: 'app', refs: [{ ref: 'refs/heads/feature', old: ZERO, new: sha('b'), kind: 'create', force: false }] },
    ]);
    const decision = h.auditLines.map(l => JSON.parse(l)).find(l => l.type === 'push_decision');
    assert.equal(decision.approved, true);
  });

  it('ask + denied -> side-band report-status with "ng <ref> rejected by user", nothing pushed', async () => {
    h = await harness({ pushApproval: (_b, _req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":false}') });
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const body = receivePackBody(
      [
        { old: sha('a'), new: sha('b'), ref: 'refs/heads/main' },
        { old: ZERO, new: sha('c'), ref: 'refs/heads/x' },
      ],
      'report-status side-band-64k',
      randomBytes(512 * 1024),
    );
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/x-git-receive-pack-result');
    assert.deepEqual(reportLines(r.body), ['unpack ok', 'ng refs/heads/main rejected by user', 'ng refs/heads/x rejected by user']);
    assert.match(r.body.toString('latin1'), /\x02git-proxy: push rejected/);
    assert.equal(h.upstreamSeen.length, 0);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(h.auditPosts.some(e => e.type === 'push_decision' && e.approved === false));
  });

  it('denied without report-status/side-band -> plain 403', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const body = receivePackBody([{ old: sha('a'), new: sha('b'), ref: 'refs/heads/dev' }], 'quiet', pack);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body });
    assert.equal(r.status, 403);
    assert.match(r.body.toString(), /push rejected/);
  });

  it('pushMode deny -> rejected without asking; receive-pack advertisement refused', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'deny' }]);
    const adv = await request(`${h.proxy}/acme/app.git/info/refs?service=git-receive-pack`, { headers: { authorization: basic(token) } });
    assert.equal(adv.status, 403);
    const body = receivePackBody([{ old: sha('a'), new: sha('b'), ref: 'refs/heads/dev' }], 'report-status', pack);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body });
    assert.deepEqual(reportLines(r.body), ['unpack ok', 'ng refs/heads/dev push disabled for this repository']);
    assert.equal(h.approvals.length, 0);
    assert.equal(h.upstreamSeen.length, 0);
  });

  it('pushMode allow: fast-forward goes straight through; delete and force need approval', async () => {
    h = await harness({
      compare: async (_p, _o, _r, _b, head) => (head === sha('f') ? 'diverged' : 'ahead'),
      pushApproval: (_b, _req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":true}'),
    });
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'allow' }]);
    const send = (cmds: { old: string; new: string; ref: string }[]) =>
      request(`${h!.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body: receivePackBody(cmds, undefined, pack) });

    assert.equal((await send([{ old: sha('a'), new: sha('b'), ref: 'refs/heads/main' }])).status, 200);
    assert.equal(h.approvals.length, 0);

    await send([{ old: sha('a'), new: ZERO, ref: 'refs/heads/old' }]);
    assert.equal(h.approvals.length, 1);
    assert.deepEqual(h.approvals[0].refs[0], { ref: 'refs/heads/old', old: sha('a'), new: ZERO, kind: 'delete', force: false });

    await send([{ old: sha('a'), new: sha('f'), ref: 'refs/heads/feature' }]);
    assert.equal(h.approvals.length, 2);
    assert.deepEqual(h.approvals[1].refs[0], { ref: 'refs/heads/feature', old: sha('a'), new: sha('f'), kind: 'update', force: true });
    assert.equal(h.upstreamSeen.length, 3);
  });

  it('gzip receive-pack body is decompressed, parsed and forwarded uncompressed', async () => {
    h = await harness({ pushApproval: (_b, _req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"approved":true}') });
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const raw = receivePackBody([{ old: sha('1'), new: sha('2'), ref: 'refs/heads/dev' }], undefined, pack);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, {
      method: 'POST',
      headers: { ...RP_HEADERS, authorization: basic(token), 'content-encoding': 'gzip' },
      body: gzipSync(raw),
    });
    assert.equal(r.status, 200);
    assert.equal(h.approvals[0].refs[0].ref, 'refs/heads/dev');
    assert.equal(h.upstreamSeen[0]!.headers['content-encoding'], undefined);
    assert.ok(h.upstreamSeen[0]!.body.equals(raw));
  });

  it('flush-only auth probe is forwarded without approval', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body: FLUSH_PKT });
    assert.equal(r.status, 200);
    assert.equal(h.approvals.length, 0);
    assert.ok(h.upstreamSeen[0]!.body.equals(FLUSH_PKT));
  });

  it('approval timeout -> rejected', async () => {
    h = await harness({ approvalTimeoutMs: 300, pushApproval: () => undefined /* never answers */ });
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const body = receivePackBody([{ old: sha('a'), new: sha('b'), ref: 'refs/heads/dev' }], 'report-status side-band-64k', pack);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body });
    assert.deepEqual(reportLines(r.body), ['unpack ok', 'ng refs/heads/dev rejected: approval timed out']);
    assert.equal(h.upstreamSeen.length, 0);
  });

  it('malformed command section -> 400', async () => {
    h = await harness();
    const token = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'allow' }]);
    const r = await request(`${h.proxy}/acme/app.git/git-receive-pack`, { method: 'POST', headers: { ...RP_HEADERS, authorization: basic(token) }, body: '0010garbage!!\n0000' });
    assert.equal(r.status, 400);
    assert.equal(h.upstreamSeen.length, 0);
  });
});

describe('LFS batch pass-through', () => {
  it('forwards batch requests with injected credentials; deny mode blocks uploads', async () => {
    h = await harness();
    const allow = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'ask' }]);
    const batch = JSON.stringify({ operation: 'upload', objects: [{ oid: 'a'.repeat(64), size: 3 }] });
    const lfsHeaders = { 'content-type': 'application/vnd.git-lfs+json', accept: 'application/vnd.git-lfs+json' };
    const r = await request(`${h.proxy}/acme/app.git/info/lfs/objects/batch`, { method: 'POST', headers: { ...lfsHeaders, authorization: basic(allow) }, body: batch });
    assert.equal(r.status, 200);
    assert.equal(h.upstreamSeen[0]!.url, '/acme/app.git/info/lfs/objects/batch');
    assert.equal(h.upstreamSeen[0]!.body.toString(), batch);
    assert.match(String(h.upstreamSeen[0]!.headers.authorization), /^Basic /);

    const deny = h.mint([{ owner: 'acme', repo: 'app', pushMode: 'deny' }]);
    const up = await request(`${h.proxy}/acme/app.git/info/lfs/objects/batch`, { method: 'POST', headers: { ...lfsHeaders, authorization: basic(deny) }, body: batch });
    assert.equal(up.status, 403);
    const down = await request(`${h.proxy}/acme/app.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: { ...lfsHeaders, authorization: basic(deny) },
      body: JSON.stringify({ operation: 'download', objects: [] }),
    });
    assert.equal(down.status, 200);
    assert.equal(h.upstreamSeen.length, 2);
  });
});
