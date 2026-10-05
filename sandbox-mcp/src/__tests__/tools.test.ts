import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requiresApproval, checkApprovalGate } from '../approval.js';
import { ownerOf } from '../tools/types.js';
import { formatRunResult } from '../tools/runBash.js';

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

describe('sandbox owner', () => {
  it('a chat in a project uses the project sandbox; a standalone chat uses its own', () => {
    assert.equal(ownerOf({ _conversation_id: 'c1', _project_id: 'p1' }), 'p1');
    assert.equal(ownerOf({ _conversation_id: 'c1' }), 'c1');
    assert.equal(ownerOf({}), 'default');
  });
});

describe('run_bash result formatting', () => {
  const base = { terminal: 'main', output: 'hi\n', exitCode: 0, timedOut: false, truncated: false, terminalClosed: false };

  it('success: output plus exit code, not an error', () => {
    assert.deepEqual(formatRunResult(base, 1000), { text: 'hi\nexit code: 0', isError: false });
  });

  it('non-zero exit is an error', () => {
    const r = formatRunResult({ ...base, exitCode: 2 }, 1000);
    assert.equal(r.isError, true);
    assert.match(r.text, /exit code: 2/);
  });

  it('timeout explains that the terminal was killed and suggests background jobs', () => {
    const r = formatRunResult({ ...base, exitCode: null, timedOut: true, terminalClosed: true }, 5000);
    assert.equal(r.isError, true);
    assert.match(r.text, /timed out after 5000ms/);
    assert.match(r.text, /nohup/);
    assert.doesNotMatch(r.text, /exit code/);
  });

  it('a shell that exited reports it', () => {
    const r = formatRunResult({ ...base, exitCode: null, terminalClosed: true }, 1000);
    assert.equal(r.isError, true);
    assert.match(r.text, /shell exited/);
  });
});
