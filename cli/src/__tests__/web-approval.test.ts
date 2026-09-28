import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebApprovalGate, looksDangerous } from '../web-approval.js';

describe('WebApprovalGate', () => {
  it('parks confirm() until resolve() is called, then returns that answer', async () => {
    const gate = new WebApprovalGate();
    const promise = gate.confirm('conv-1', 'sandbox/run_bash', { command: 'ls' });

    assert.equal(gate.listPending().length, 1);
    const id = gate.listPending()[0].id;

    const ok = gate.resolve(id, true, 'once');
    assert.equal(ok, true);
    assert.equal(await promise, true);
    assert.equal(gate.listPending().length, 0);
  });

  it('resolve() on an unknown id returns false and does not throw', () => {
    const gate = new WebApprovalGate();
    assert.equal(gate.resolve('nope', true, 'once'), false);
  });

  it("scope='always' lets subsequent routine calls to the same tool skip the queue globally", async () => {
    const gate = new WebApprovalGate();

    const first = gate.confirm('conv-1', 'obsidian/write_note', { path: 'a.md' });
    const id = gate.listPending()[0].id;
    gate.resolve(id, true, 'always');
    assert.equal(await first, true);

    // Second call to the same tool from a DIFFERENT conversation skips the queue (global).
    const second = await gate.confirm('conv-2', 'obsidian/write_note', { path: 'b.md' });
    assert.equal(second, true);
    assert.equal(gate.listPending().length, 0);
  });

  it("scope='chat' only auto-approves within the same conversation", async () => {
    const gate = new WebApprovalGate();

    // Grant 'chat' scope for conv-1
    const first = gate.confirm('conv-1', 'obsidian/write_note', { path: 'a.md' });
    gate.resolve(gate.listPending()[0].id, true, 'chat');
    assert.equal(await first, true);

    // Same tool, same conversation — should auto-approve
    const sameConv = await gate.confirm('conv-1', 'obsidian/write_note', { path: 'b.md' });
    assert.equal(sameConv, true);
    assert.equal(gate.listPending().length, 0);

    // Same tool, DIFFERENT conversation — must queue
    const otherConv = gate.confirm('conv-2', 'obsidian/write_note', { path: 'c.md' });
    assert.equal(gate.listPending().length, 1);
    gate.resolve(gate.listPending()[0].id, false, 'once');
    assert.equal(await otherConv, false);
  });

  it("scope='once' does not grant future auto-approval", async () => {
    const gate = new WebApprovalGate();

    const first = gate.confirm('conv-1', 'obsidian/write_note', { path: 'a.md' });
    gate.resolve(gate.listPending()[0].id, true, 'once');
    assert.equal(await first, true);

    // Same tool, same conversation — must still queue
    const second = gate.confirm('conv-1', 'obsidian/write_note', { path: 'b.md' });
    assert.equal(gate.listPending().length, 1);
    gate.resolve(gate.listPending()[0].id, false, 'once');
    assert.equal(await second, false);
  });

  it('a dangerous-looking call always queues, even for an "always" allowed tool', async () => {
    const gate = new WebApprovalGate();

    const routine = gate.confirm('conv-1', 'sandbox/run_bash', { command: 'ls' });
    gate.resolve(gate.listPending()[0].id, true, 'always');
    await routine;

    const dangerous = gate.confirm('conv-1', 'sandbox/run_bash', { command: 'rm -rf /tmp/x' });
    assert.equal(gate.listPending().length, 1);
    assert.equal(gate.listPending()[0].dangerous, true);
    gate.resolve(gate.listPending()[0].id, true, 'once');
    assert.equal(await dangerous, true);
  });

  it("scope='always' is silently ignored for a dangerous call — no persistent bypass granted", async () => {
    const gate = new WebApprovalGate();

    // Try to grant 'always' for a dangerous call — should be blocked
    const dangerous = gate.confirm('conv-1', 'sandbox/run_bash', { command: 'rm -rf /tmp/x' });
    gate.resolve(gate.listPending()[0].id, true, 'always'); // scope='always', but call is dangerous
    await dangerous;

    // Same tool, routine command — must still queue, since the previous grant never stuck
    const routine = gate.confirm('conv-1', 'sandbox/run_bash', { command: 'ls' });
    assert.equal(gate.listPending().length, 1);
    gate.resolve(gate.listPending()[0].id, false, 'once');
    assert.equal(await routine, false);
  });

  it('unknown scope string falls back to once (no crash)', () => {
    const gate = new WebApprovalGate();
    // TypeScript prevents this at compile time, but the server validates at runtime too —
    // test the raw JS behaviour to make sure resolve() doesn't throw on a bad value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.doesNotThrow(() => gate.resolve('unknown-id', true, 'bogus' as any));
  });
});

describe('looksDangerous — browser-action patterns (§6b)', () => {
  const dangerousLabels = [
    'Delete Account',
    'delete my account',
    'Cancel subscription',
    'Place Order',
    'Confirm order',
    'Buy now',
    'Complete payment',
    'Pay Now',
    'Wire transfer',
    'Unsubscribe',
    'Send money',
    'Delete repository',
  ];

  for (const label of dangerousLabels) {
    it(`flags browser_act with label "${label}" as dangerous`, () => {
      assert.equal(looksDangerous({ action: 'click', ref: 3, label }), true);
    });
  }

  const routineLabels = ['Search', 'Add to cart', 'Next page', 'Home', 'Email address', 'Log in'];

  for (const label of routineLabels) {
    it(`does not flag browser_act with label "${label}" as dangerous`, () => {
      assert.equal(looksDangerous({ action: 'click', ref: 3, label }), false);
    });
  }

  it('a dangerous label still queues even after the tool was granted "always" scope', async () => {
    const gate = new WebApprovalGate();

    const routine = gate.confirm('conv-1', 'playwright/browser_act', { action: 'click', ref: 1, label: 'Add to cart' });
    gate.resolve(gate.listPending()[0].id, true, 'always');
    await routine;

    const dangerous = gate.confirm('conv-1', 'playwright/browser_act', {
      action: 'click',
      ref: 2,
      label: 'Delete Account',
    });
    assert.equal(gate.listPending().length, 1);
    assert.equal(gate.listPending()[0].dangerous, true);
    gate.resolve(gate.listPending()[0].id, true, 'once');
    assert.equal(await dangerous, true);
  });
});
