import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requiresApproval, checkApprovalGate } from '../approval.js';
import { ownerOf } from '../tools/types.js';
import { formatRunResult } from '../tools/runBash.js';
import { formatCheckpoints } from '../tools/checkpoints.js';
import { SupervisorClient } from '../supervisor-client.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

describe('checkpoint tools', () => {
  it('rollback requires approval; checkpoint_list does not', () => {
    assert.equal(requiresApproval('rollback'), true);
    assert.equal(checkApprovalGate('rollback', []).decision, 'deny');
    assert.equal(checkApprovalGate('rollback', ['rollback']).decision, 'allow');
    assert.equal(checkApprovalGate('checkpoint_list', []).decision, 'allow');
  });

  it('formats the checkpoint list', () => {
    assert.match(formatCheckpoints([]), /No checkpoints yet/);
    const text = formatCheckpoints([
      { id: 'abc-1234', label: 'Before turn 2', commit: 'f'.repeat(40), createdAt: '2026-10-05T10:00:00.000Z' },
      { id: 'abb-5678', label: '', commit: 'e'.repeat(40), createdAt: '2026-10-05T09:00:00.000Z' },
    ]);
    assert.equal(text.split('\n').length, 2);
    assert.match(text, /^abc-1234 {2}2026-10-05T10:00:00.000Z {2}Before turn 2/);
    assert.match(text, /\(no label\)/);
  });

  it('SupervisorClient calls the per-owner checkpoint endpoints', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        res.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/checkpoints')) res.end(JSON.stringify({ checkpoints: [{ id: 'a-1234', label: 'x', commit: 'c', createdAt: 't' }] }));
        else res.end(JSON.stringify({ ok: true, checkpointId: 'a-1234', commit: 'c' }));
      });
    }).listen(0);
    try {
      const client = new SupervisorClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      assert.equal((await client.listCheckpoints('proj-1'))[0]!.id, 'a-1234');
      assert.equal((await client.rollback('proj-1', 'a-1234')).ok, true);
      assert.deepEqual(seen, ['GET /sandboxes/proj-1/checkpoints ', 'POST /sandboxes/proj-1/rollback {"checkpointId":"a-1234"}']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
