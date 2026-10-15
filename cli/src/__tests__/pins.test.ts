import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { addPin, createConversation, createProject, deleteConversation, deleteProject, listPins, openDb, removePin, runMigrations } from '../db.js';
import { fileTools } from '../file-tools.js';
import { buildApp } from '../server.js';

describe('workspace pins', () => {
  it('a pin is a pointer: pinning twice keeps one row, a note sticks, removing and deleting the owner clean up', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const project = createProject(db, { name: 'p' });
    const chat = createConversation(db, {}).id;
    addPin(db, project.id, '/workspace/a.md', 'first');
    addPin(db, project.id, '/workspace/a.md');
    addPin(db, chat, '/workspace/b.md');
    assert.deepEqual(listPins(db, project.id).map(p => [p.path, p.note]), [['/workspace/a.md', 'first']]);
    assert.equal(removePin(db, project.id, '/workspace/a.md'), true);
    assert.equal(removePin(db, project.id, '/workspace/a.md'), false);
    assert.equal(deleteConversation(db, chat), true);
    assert.deepEqual(listPins(db, chat), []);
    addPin(db, project.id, '/workspace/c.md');
    assert.equal(deleteProject(db, project.id), true);
    assert.deepEqual(listPins(db, project.id), []);
  });

  it('pin_file / unpin_file: only existing files inside /workspace, no approval, and only when pins are wired', async () => {
    const pinned = new Map<string, string | undefined>();
    const deps = {
      owner: 'o',
      sandbox: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      readFile: async (_o: string, p: string) => { if (p !== '/workspace/out/report.md') throw new Error('missing'); return Buffer.from('# r'); },
      pins: { add: (p: string, n?: string) => { pinned.set(p, n); }, remove: (p: string) => pinned.delete(p) },
    };
    const tools = new Map(fileTools(deps).map(t => [t.definition.name, t]));
    assert.ok(tools.has('pin_file') && tools.has('unpin_file'));
    assert.equal(tools.get('pin_file')!.requiresApproval, undefined);

    const ok = await tools.get('pin_file')!.handler({ path: 'out/report.md', note: 'the result' }, { toolUseId: 't' });
    assert.equal(ok.isError, undefined);
    assert.deepEqual([...pinned], [['/workspace/out/report.md', 'the result']]);
    assert.equal((await tools.get('pin_file')!.handler({ path: 'nope.md' }, { toolUseId: 't' })).isError, true);
    assert.equal((await tools.get('pin_file')!.handler({ path: '../../etc/passwd' }, { toolUseId: 't' })).isError, true);
    assert.equal((await tools.get('unpin_file')!.handler({ path: 'out/report.md' }, { toolUseId: 't' })).isError, undefined);
    assert.equal((await tools.get('unpin_file')!.handler({ path: 'out/report.md' }, { toolUseId: 't' })).isError, true);

    const without = fileTools({ ...deps, pins: undefined }).map(t => t.definition.name);
    assert.deepEqual(without, ['read_file', 'edit_file', 'write_file']);
  });

  it('API: list, pin an existing file, refuse a missing one or a path outside /workspace, unpin', async () => {
    const supervisor = http.createServer((rq, rs) => {
      const u = new URL(rq.url ?? '/', 'http://x');
      if (u.pathname.endsWith('/file') && u.searchParams.get('path') === '/workspace/r.md') { rs.setHeader('content-type', 'text/plain'); rs.end('# r'); return; }
      rs.statusCode = 404; rs.setHeader('content-type', 'application/json'); rs.end('{"error":"no such file"}');
    });
    await new Promise<void>(r => supervisor.listen(0, r));
    const prev = process.env['SUPERVISOR_URL'];
    process.env['SUPERVISOR_URL'] = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;
    const db = openDb(':memory:');
    runMigrations(db);
    const built = await buildApp({ db, connections: [], llm: {} as any, authToken: 't', config: { model: 'm', autoApproveTools: [] } });
    const server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { authorization: 'Bearer t', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, res => {
        const c: Buffer[] = [];
        res.on('data', d => c.push(d));
        res.on('end', () => { const t = Buffer.concat(c).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
    try {
      const chat = createConversation(db, {}).id;
      assert.deepEqual((await call('GET', `/api/workspace/${chat}/pins`)).json.pins, []);
      const made = await call('POST', `/api/workspace/${chat}/pins`, { path: 'r.md', note: 'result' });
      assert.equal(made.status, 201);
      assert.equal(made.json.path, '/workspace/r.md');
      assert.equal((await call('POST', `/api/workspace/${chat}/pins`, { path: 'missing.md' })).status, 404);
      assert.equal((await call('POST', `/api/workspace/${chat}/pins`, { path: '/etc/passwd' })).status, 400);
      assert.equal((await call('POST', `/api/workspace/nope/pins`, { path: 'r.md' })).status, 404);
      assert.equal((await call('GET', `/api/workspace/${chat}/pins`)).json.pins.length, 1);
      assert.equal((await call('DELETE', `/api/workspace/${chat}/pins?path=${encodeURIComponent('/workspace/r.md')}`)).json.ok, true);
      assert.deepEqual((await call('GET', `/api/workspace/${chat}/pins`)).json.pins, []);
    } finally {
      built.stop(); server.close(); db.close(); supervisor.close();
      if (prev === undefined) delete process.env['SUPERVISOR_URL']; else process.env['SUPERVISOR_URL'] = prev;
    }
  });
});
