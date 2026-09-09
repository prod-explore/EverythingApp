import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebApprovalGate } from '../web-approval.js';

describe('WebApprovalGate', () => {
  it('parks confirm() until resolve() is called, then returns that answer', async () => {
    const gate = new WebApprovalGate();
    const promise = gate.confirm('sandbox/run_bash', { command: 'ls' });

    assert.equal(gate.listPending().length, 1);
    const id = gate.listPending()[0].id;

    const ok = gate.resolve(id, true, false);
    assert.equal(ok, true);
    assert.equal(await promise, true);
    assert.equal(gate.listPending().length, 0);
  });

  it('resolve() on an unknown id returns false and does not throw', () => {
    const gate = new WebApprovalGate();
    assert.equal(gate.resolve('nope', true, false), false);
  });

  it('alwaysAllow lets subsequent routine calls to the same tool skip the queue', async () => {
    const gate = new WebApprovalGate();

    const first = gate.confirm('obsidian/write_note', { path: 'a.md' });
    const id = gate.listPending()[0].id;
    gate.resolve(id, true, true);
    assert.equal(await first, true);

    // Second call to the same tool never appears in the pending queue.
    const second = await gate.confirm('obsidian/write_note', { path: 'b.md' });
    assert.equal(second, true);
    assert.equal(gate.listPending().length, 0);
  });

  it('a dangerous-looking call always queues, even for an "always allowed" tool', async () => {
    const gate = new WebApprovalGate();

    const routine = gate.confirm('sandbox/run_bash', { command: 'ls' });
    gate.resolve(gate.listPending()[0].id, true, true);
    await routine;

    const dangerous = gate.confirm('sandbox/run_bash', { command: 'rm -rf /tmp/x' });
    assert.equal(gate.listPending().length, 1);
    assert.equal(gate.listPending()[0].dangerous, true);
    gate.resolve(gate.listPending()[0].id, true, false);
    assert.equal(await dangerous, true);
  });

  it('alwaysAllow is ignored for a dangerous call — no persistent bypass granted', async () => {
    const gate = new WebApprovalGate();

    const dangerous = gate.confirm('sandbox/run_bash', { command: 'rm -rf /tmp/x' });
    gate.resolve(gate.listPending()[0].id, true, true); // alwaysAllow=true, but call is dangerous
    await dangerous;

    // Same tool, routine command — must still queue, since the previous grant never stuck.
    const routine = gate.confirm('sandbox/run_bash', { command: 'ls' });
    assert.equal(gate.listPending().length, 1);
    gate.resolve(gate.listPending()[0].id, false, false);
    assert.equal(await routine, false);
  });
});
