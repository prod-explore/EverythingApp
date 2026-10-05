import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ROLLBACK_NOT_FOUND,
  checkpointScript,
  listScript,
  newCheckpointId,
  parseCheckpointOutput,
  parseListOutput,
  rollbackScript,
  validCheckpointId,
} from '../checkpoints.js';
import { SandboxManager } from '../sandboxes.js';
import { createSupervisorApp } from '../api.js';
import { fakeOps, localExec } from './helpers.js';

/** A temp dir standing in for /workspace; the scripts run with the local bash + git (in the sandbox: docker exec). */
const tempWorkspace = () => mkdtempSync(path.join(tmpdir(), 'ea-cp-')).replace(/\\/g, '/');

describe('checkpoint scripts against real git', () => {
  let ws: string;
  before(() => {
    ws = tempWorkspace();
    // The user's own repo at the workspace root must never be touched.
    assert.equal(localExec(`cd '${ws}' && git init -q && git config user.email u@x && git config user.name u`).exitCode, 0);
    writeFileSync(`${ws}/.git/USER_MARKER`, 'mine');
    writeFileSync(`${ws}/.gitignore`, 'node_modules/\n');
    writeFileSync(`${ws}/a.txt`, 'v1');
    mkdirSync(`${ws}/node_modules`);
    writeFileSync(`${ws}/node_modules/dep.js`, 'dep');
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  it('snapshots, lists and rolls back, leaving ignored files, the user repo and the meta dir alone', () => {
    const id1 = newCheckpointId(Date.now());
    const evil = `turn 1: it's "quoted" $(touch ${ws}/pwned) \`touch ${ws}/pwned2\``;
    const r1 = localExec(checkpointScript(id1, evil, ws));
    assert.equal(r1.exitCode, 0, r1.stderr);
    const out1 = parseCheckpointOutput(r1.stdout);
    assert.match(out1.commit, /^[0-9a-f]{40}$/);
    assert.ok(!existsSync(`${ws}/pwned`) && !existsSync(`${ws}/pwned2`), 'label is never shell-evaluated');

    writeFileSync(`${ws}/a.txt`, 'v2');
    writeFileSync(`${ws}/b.txt`, 'new in turn 2');
    const id2 = newCheckpointId(Date.now() + 1);
    assert.equal(localExec(checkpointScript(id2, 'turn 2', ws)).exitCode, 0);

    // The agent makes a mess.
    writeFileSync(`${ws}/a.txt`, 'v3');
    writeFileSync(`${ws}/untracked.txt`, 'junk');
    mkdirSync(`${ws}/newdir`);
    writeFileSync(`${ws}/newdir/x`, 'junk');
    writeFileSync(`${ws}/node_modules/added-later.js`, 'kept: ignored');
    writeFileSync(`${ws}/.ea-checkpoints/actions.log`, 'log');

    const list = parseListOutput(localExec(listScript(ws)).stdout);
    assert.deepEqual(list.map(c => c.id).sort(), [id1, id2].sort());
    assert.equal(list.find(c => c.id === id1)!.label, evil);
    assert.equal(list.find(c => c.id === id1)!.commit, out1.commit);

    const rb = localExec(rollbackScript(id1, ws));
    assert.equal(rb.exitCode, 0, rb.stderr);
    assert.equal(parseCheckpointOutput(rb.stdout).commit, out1.commit);
    assert.equal(readFileSync(`${ws}/a.txt`, 'utf8'), 'v1');
    assert.ok(!existsSync(`${ws}/b.txt`), 'file created after the checkpoint is gone');
    assert.ok(!existsSync(`${ws}/untracked.txt`));
    assert.ok(!existsSync(`${ws}/newdir`));
    assert.ok(existsSync(`${ws}/node_modules/dep.js`) && existsSync(`${ws}/node_modules/added-later.js`), 'ignored files survive');
    assert.equal(readFileSync(`${ws}/.git/USER_MARKER`, 'utf8'), 'mine', "user's .git untouched");
    assert.equal(readFileSync(`${ws}/.ea-checkpoints/actions.log`, 'utf8'), 'log', 'meta dir untouched');
    // The user's repo never saw any of this.
    assert.equal(localExec(`cd '${ws}' && git rev-parse --verify -q HEAD`).exitCode !== 0, true, 'user repo still has no commits');

    // Later checkpoints are still listed and can be restored ("redo").
    assert.equal(localExec(rollbackScript(id2, ws)).exitCode, 0);
    assert.equal(readFileSync(`${ws}/a.txt`, 'utf8'), 'v2');
    assert.ok(existsSync(`${ws}/b.txt`));
  });

  it('unknown checkpoint → exit 3; no repo yet → empty list and exit 3', () => {
    assert.equal(localExec(rollbackScript('zzz-abcd', ws)).exitCode, ROLLBACK_NOT_FOUND);
    const fresh = tempWorkspace();
    try {
      const l = localExec(listScript(fresh));
      assert.equal(l.exitCode, 0);
      assert.deepEqual(parseListOutput(l.stdout), []);
      assert.equal(localExec(rollbackScript('zzz-abcd', fresh)).exitCode, ROLLBACK_NOT_FOUND);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('nested repositories do not break a checkpoint; they come back as warnings', () => {
    const fresh = tempWorkspace();
    try {
      writeFileSync(`${fresh}/top.txt`, 'top');
      const ident = `git -c user.email=u@x -c user.name=u`;
      assert.equal(localExec(`cd '${fresh}' && mkdir app && cd app && git init -q && echo x > x && git add x && ${ident} commit -qm x`).exitCode, 0);
      assert.equal(localExec(`cd '${fresh}' && mkdir empty && cd empty && git init -q && echo y > y`).exitCode, 0);
      const r = localExec(checkpointScript('a-1234', 'nested', fresh));
      assert.equal(r.exitCode, 0, r.stderr);
      const { warnings, commit } = parseCheckpointOutput(r.stdout);
      assert.match(commit, /^[0-9a-f]{40}$/);
      assert.ok(warnings.length >= 1, `expected warnings, got ${JSON.stringify(warnings)}`);
      assert.ok(warnings.some(w => /app/.test(w)), JSON.stringify(warnings));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('ids are validated before they reach a script', () => {
    assert.equal(validCheckpointId(newCheckpointId(Date.now())), true);
    for (const bad of ['', 'x', "a-1234'; rm -rf /", '../a-1234', 'A-1234', 'abc-xyz1', 42]) assert.equal(validCheckpointId(bad), false, String(bad));
    assert.throws(() => rollbackScript("a-1234'; rm -rf /"));
    assert.throws(() => checkpointScript('nope', 'x'));
  });

  it('scripts only ever touch the checkpoint git dir', () => {
    for (const s of [checkpointScript('a-1234', 'x'), listScript(), rollbackScript('a-1234')]) {
      assert.match(s, /export GIT_DIR='\/workspace\/\.ea-checkpoints' GIT_WORK_TREE='\/workspace'/);
    }
  });
});

describe('checkpoint HTTP API (manager + real git via fake exec)', () => {
  let ws: string;
  let server: Server;
  let base: string;
  let mgr: SandboxManager;

  before(() => {
    ws = tempWorkspace();
    const { ops } = fakeOps({
      // `docker exec` → local bash, with /workspace mapped onto the temp dir.
      exec: async (_id, command) => localExec(command.split('/workspace').join(ws)),
    });
    mgr = new SandboxManager(ops);
    server = createSupervisorApp(mgr, 5000).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await mgr.shutdown();
    rmSync(ws, { recursive: true, force: true });
  });

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  it('list before anything exists is empty and creates nothing', async () => {
    const r = await call('GET', '/sandboxes/nothing-here/checkpoints');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.checkpoints, []);
    assert.equal(mgr.sandboxStatus('nothing-here'), null);
  });

  it('checkpoint → list → rollback', async () => {
    writeFileSync(`${ws}/f.txt`, 'before');
    const cp = await call('POST', '/sandboxes/p1/checkpoint', { label: 'Before turn 7' });
    assert.equal(cp.status, 200, JSON.stringify(cp.json));
    assert.ok(validCheckpointId(cp.json.id));
    assert.equal(cp.json.label, 'Before turn 7');
    assert.match(cp.json.commit, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(cp.json.warnings));
    assert.ok(cp.json.createdAt);

    writeFileSync(`${ws}/f.txt`, 'after');
    writeFileSync(`${ws}/g.txt`, 'new');

    const list = await call('GET', '/sandboxes/p1/checkpoints');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.checkpoints.map((c: { id: string }) => c.id), [cp.json.id]);

    const rb = await call('POST', '/sandboxes/p1/rollback', { checkpointId: cp.json.id });
    assert.equal(rb.status, 200, JSON.stringify(rb.json));
    assert.equal(rb.json.ok, true);
    assert.equal(rb.json.commit, cp.json.commit);
    assert.equal(readFileSync(`${ws}/f.txt`, 'utf8'), 'before');
    assert.ok(!existsSync(`${ws}/g.txt`));
    // Both operations are in the action log (kept in the meta dir, which rollback does not touch).
    const log = readFileSync(`${ws}/.ea-checkpoints/actions.log`, 'utf8');
    assert.match(log, /\[checkpoint\] cp-/);
    assert.match(log, /\[rollback\] cp-/);
  });

  it('rollback validation: 400 bad id, 404 unknown id, 409 while a command runs', async () => {
    assert.equal((await call('POST', '/sandboxes/p1/rollback', {})).status, 400);
    assert.equal((await call('POST', '/sandboxes/p1/rollback', { checkpointId: "x'; rm -rf /" })).status, 400);
    assert.equal((await call('POST', '/sandboxes/p1/rollback', { checkpointId: 'zzzz-abcd' })).status, 404);
    const busy = mgr.run('p1', 'build', 'sleep 1', 5000);
    await new Promise(r => setTimeout(r, 300));
    const r = await call('POST', '/sandboxes/p1/rollback', { checkpointId: 'zzzz-abcd' });
    assert.equal(r.status, 409);
    await busy;
  });

  it('a label-less checkpoint gets a default label', async () => {
    const cp = await call('POST', '/sandboxes/p1/checkpoint', {});
    assert.equal(cp.status, 200);
    assert.equal(cp.json.label, 'checkpoint');
  });
});
