import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../approval.js';

function fakeReadline(answers: string[]): { question: (prompt: string) => Promise<string> } {
  let i = 0;
  return {
    async question() {
      const answer = answers[i];
      i += 1;
      if (answer === undefined) throw new Error('fakeReadline ran out of scripted answers');
      return answer;
    },
  };
}

describe('ApprovalGate', () => {
  it('denies by default on anything other than y/a', async () => {
    const gate = new ApprovalGate(fakeReadline(['n']) as any);
    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'ls' }), false);
  });

  it('approves once on y without remembering it', async () => {
    const rl = fakeReadline(['y', 'n']);
    const gate = new ApprovalGate(rl as any);
    assert.equal(await gate.confirm('sandbox/run_bash', {}), true);
    // second call for the SAME tool still prompts (not remembered) — this script's second answer is 'n'
    assert.equal(await gate.confirm('sandbox/run_bash', {}), false);
  });

  it('"a" approves this call and every future call to the same tool without prompting again', async () => {
    const rl = fakeReadline(['a']);
    const gate = new ApprovalGate(rl as any);

    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'ls' }), true);
    // No more scripted answers left — if this prompted again, it would throw.
    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'echo hi' }), true);
  });

  it('"always allow" is scoped per tool, not global', async () => {
    const rl = fakeReadline(['a', 'n']);
    const gate = new ApprovalGate(rl as any);

    assert.equal(await gate.confirm('sandbox/run_bash', {}), true);
    // a different tool still has to prompt — second scripted answer 'n'
    assert.equal(await gate.confirm('obsidian/write_note', {}), false);
  });

  it('re-prompts for a dangerous-looking call even on an "always allowed" tool', async () => {
    const rl = fakeReadline(['a', 'y']);
    const gate = new ApprovalGate(rl as any);

    // First call is routine — "a" grants always-allow for this tool.
    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'ls -la' }), true);
    // Second call to the SAME tool looks destructive — must still prompt (second scripted answer 'y').
    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'rm -rf /tmp/x' }), true);
  });

  it('"a" on a dangerous call approves once but does not grant future always-allow', async () => {
    const rl = fakeReadline(['a', 'n']);
    const gate = new ApprovalGate(rl as any);

    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'rm -rf /tmp/x' }), true);
    // Same tool, now a routine command — still has to prompt, since the previous "a" didn't stick.
    assert.equal(await gate.confirm('sandbox/run_bash', { command: 'ls' }), false);
  });
});
