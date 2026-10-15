import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations } from '../db.js';

const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-web-'));
fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>app</title>');
fs.mkdirSync(path.join(webDir, 'assets'));
fs.writeFileSync(path.join(webDir, 'assets', 'a.js'), 'console.log(1)');
process.env['WEB_DIST'] = webDir;

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

describe('static frontend', () => {
  let built: BuiltApp; let server: http.Server; let port: number; let db: ReturnType<typeof openDb>;
  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    built = await buildApp({ db, connections: [], authToken: 't', config: { model: '@test/m', autoApproveTools: [] } });
    server = built.app.listen(0); port = (server.address() as AddressInfo).port;
  });
  after(() => { built.stop(); server.close(); db.close(); fs.rmSync(webDir, { recursive: true, force: true }); delete process.env['WEB_DIST']; });

  it('serves the app at / and for client-side routes, assets as files, and 404 for a missing file', async () => {
    assert.match((await get(port, '/')).body, /<title>app<\/title>/);
    const route = await get(port, '/chat/some-id');
    assert.equal(route.status, 200);
    assert.match(route.body, /<title>app<\/title>/);
    assert.equal((await get(port, '/assets/a.js')).body, 'console.log(1)');
    assert.equal((await get(port, '/assets/missing.js')).status, 404);
  });
});
