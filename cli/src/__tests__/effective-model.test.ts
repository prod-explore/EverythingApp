import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../server.js';
import { openDb, runMigrations, setSetting, getSetting } from '../db.js';

const TOKEN = 't';
function get(port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
    }).on('error', reject);
  });
}
function post(port: number, path: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'content-length': Buffer.byteLength(payload) } }, res => {
      const c: Buffer[] = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

describe('GET /api/conversations/:id — effectiveModel (UI model picker must never be empty)', () => {
  it('reports the conversation model, else the default_model setting', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const built = await buildApp({ db, connections: [], anthropic: {} as any, authToken: TOKEN, config: { model: 'config-model', autoApproveTools: [], webSearchEnabled: false } });
    const server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const plain = (await post(port, '/api/conversations', {})).id as string;
      // default_model is seeded by the migrations, so an unset conversation inherits that.
      assert.equal((await get(port, `/api/conversations/${plain}`)).effectiveModel, getSetting(db, 'default_model'));
      assert.ok((await get(port, `/api/conversations/${plain}`)).effectiveModel, 'must never be empty');

      setSetting(db, 'default_model', 'settings-model');
      assert.equal((await get(port, `/api/conversations/${plain}`)).effectiveModel, 'settings-model');

      const own = (await post(port, '/api/conversations', { model: 'own-model' })).id as string;
      const conv = await get(port, `/api/conversations/${own}`);
      assert.equal(conv.model, 'own-model');
      assert.equal(conv.effectiveModel, 'own-model');
    } finally {
      built.stop();
      server.close();
      db.close();
    }
  });
});
