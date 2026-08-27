import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requiresApproval, checkApprovalGate } from '../approval.js';

describe('Approval Gate', () => {
  it('denies run_bash when not in autoApproveTools', () => {
    const result = checkApprovalGate('run_bash', []);
    assert.equal(result.decision, 'deny');
  });

  it('allows run_bash when listed in autoApproveTools', () => {
    const result = checkApprovalGate('run_bash', ['run_bash']);
    assert.equal(result.decision, 'allow');
  });

  it('allows read_log without autoApproveTools (no approval needed)', () => {
    const result = checkApprovalGate('read_log', []);
    assert.equal(result.decision, 'allow');
  });

  it('requiresApproval returns true for run_bash', () => {
    assert.equal(requiresApproval('run_bash'), true);
  });

  it('requiresApproval returns true for git_op', () => {
    assert.equal(requiresApproval('git_op'), true);
  });

  it('requiresApproval returns false for read_log', () => {
    assert.equal(requiresApproval('read_log'), false);
  });
});

describe('git_op subcommand whitelist invariants', () => {
  const ALLOWED = new Set([
    'clone', 'status', 'diff', 'log', 'add', 'commit',
    'push', 'pull', 'fetch', 'checkout', 'branch', 'stash', 'show',
  ]);

  it('rm is NOT in the allowed subcommands', () => {
    assert.equal(ALLOWED.has('rm'), false);
  });

  it('clean is NOT in the allowed subcommands', () => {
    assert.equal(ALLOWED.has('clean'), false);
  });

  it('commit IS in the allowed subcommands', () => {
    assert.equal(ALLOWED.has('commit'), true);
  });

  it('push IS in the allowed subcommands', () => {
    assert.equal(ALLOWED.has('push'), true);
  });
});
