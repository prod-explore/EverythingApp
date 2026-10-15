import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { servePolicy, contentDisposition, sanitizeFilename } from '../artifact-http.js';
import { buildApp } from '../server.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifact, openDb, runMigrations } from '../db.js';

describe('servePolicy — only inert content is shown inline', () => {
  const cases: Array<[string, boolean, string]> = [
    ['image/png', true, 'image/png'],
    ['IMAGE/JPEG; charset=x', true, 'image/jpeg'],
    ['application/pdf', true, 'application/pdf'],
    ['text/plain', true, 'text/plain; charset=utf-8'],
    ['text/markdown', true, 'text/plain; charset=utf-8'],
    ['application/json', true, 'text/plain; charset=utf-8'],
    ['text/html', false, 'application/octet-stream'],
    ['application/xhtml+xml', false, 'application/octet-stream'],
    ['image/svg+xml', false, 'application/octet-stream'],
    ['text/xml', false, 'application/octet-stream'],
    ['application/javascript', false, 'application/octet-stream'],
    ['application/zip', false, 'application/octet-stream'],
    ['', false, 'application/octet-stream'],
  ];
  for (const [mime, inline, type] of cases) {
    it(`${mime || '(empty)'} → ${inline ? 'inline' : 'download'} as ${type}`, () => {
      const p = servePolicy(mime);
      assert.equal(p.inline, inline);
      assert.equal(p.contentType, type);
    });
  }
});

describe('contentDisposition / sanitizeFilename', () => {
  it('escapes quotes, CRLF and non-ASCII — no header injection', () => {
    const h = contentDisposition('attachment', 'a"b\r\nSet-Cookie: x=1.html');
    assert.ok(!/[\r\n]/.test(h));
    assert.match(h, /^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    assert.match(contentDisposition('inline', 'zażółć.txt'), /filename\*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87\.txt$/);
  });
  it('sanitizeFilename keeps only the last segment, strips control chars, bounds length, never empty', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('C:\\x\\y.txt'), 'y.txt');
    assert.equal(sanitizeFilename('..'), 'artifact');
    assert.equal(sanitizeFilename(''), 'artifact');
    assert.equal(sanitizeFilename('a\u0000b\r\nc.txt'), 'abc.txt');
    const long = sanitizeFilename('x'.repeat(500) + '.png');
    assert.ok(long.length <= 120 && long.endsWith('.png'));
  });
});

const TOKEN = 't';
function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe('report snapshot endpoint', () => {
  it('serves HTML/SVG as a download, text as text/plain, images inline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea-art-'));
    process.env['EVERYTHINGAPP_ARTIFACTS_DIR'] = dir;
    const db = openDb(':memory:');
    runMigrations(db);
    const built = await buildApp({ db, connections: [], llm: {} as any, authToken: TOKEN, config: { model: 'm', autoApproveTools: [] } });
    const server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const snap = (name: string, mime: string, data: string) => {
        const row = createArtifact(db, { conversationId: null, filename: name, mimeType: mime, sizeBytes: data.length, source: 'report-pin' });
        writeFileSync(join(dir, `${row.id}_${name.replace(/[^A-Za-z0-9._-]/g, '_')}`), data);
        return row;
      };

      const html = snap('evil".html', 'text/html', '<script>steal()</script>');
      const r1 = await call(port, 'GET', `/api/artifacts/${html.id}/file`);
      assert.equal(r1.headers['content-type'], 'application/octet-stream');
      assert.match(String(r1.headers['content-disposition']), /^attachment;/);
      assert.equal(r1.headers['x-content-type-options'], 'nosniff');

      const svg = snap('x.svg', 'image/svg+xml', '<svg onload="x()"/>');
      assert.match(String((await call(port, 'GET', `/api/artifacts/${svg.id}/file`)).headers['content-disposition']), /^attachment;/);

      const md = snap('n.md', 'text/markdown', '# hi');
      const mdRes = await call(port, 'GET', `/api/artifacts/${md.id}/file`);
      assert.equal(mdRes.headers['content-type'], 'text/plain; charset=utf-8');
      assert.match(String(mdRes.headers['content-disposition']), /^inline;/);
      assert.match(String(mdRes.headers['content-security-policy']), /sandbox/);

      assert.equal((await call(port, 'GET', '/api/artifacts/nope/file')).status, 404);
      // nothing uploads or lists generic artifacts any more: files the user wants at hand are pins of the workspace
      assert.equal((await call(port, 'POST', '/api/artifacts?filename=x.bin', {})).status, 404);
      assert.equal((await call(port, 'GET', '/api/artifacts')).status, 404);
    } finally {
      built.stop();
      server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env['EVERYTHINGAPP_ARTIFACTS_DIR'];
    }
  });
});
