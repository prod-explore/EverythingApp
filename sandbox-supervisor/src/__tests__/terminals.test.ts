import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from '../terminals.js';
import { localBashFactory } from './helpers.js';

let mgr: TerminalManager | undefined;
const make = (opts: ConstructorParameters<typeof TerminalManager>[1] = {}) => (mgr = new TerminalManager(localBashFactory, { cwd: '/tmp', ...opts }));
afterEach(async () => {
  await mgr?.closeAll();
  mgr = undefined;
});

describe('TerminalManager', () => {
  it('runs a command and returns output and exit code', async () => {
    const r = await make().run('main', 'echo hello', 5000);
    assert.equal(r.output, 'hello\n');
    assert.equal(r.exitCode, 0);
    assert.equal(r.terminalClosed, false);
  });

  it('keeps cwd, env vars and functions between commands', async () => {
    const m = make();
    await m.run('main', 'mkdir -p /tmp/ea-term-test && cd /tmp/ea-term-test && export FOO=bar && greet() { echo "hi $1"; }', 5000);
    const r = await m.run('main', 'pwd; echo $FOO; greet there', 5000);
    assert.equal(r.output, '/tmp/ea-term-test\nbar\nhi there\n');
  });

  it('merges stderr and reports non-zero exit codes', async () => {
    const r = await make().run('main', 'echo out; echo err >&2; exit_code() { return 7; }; exit_code', 5000);
    assert.match(r.output, /out/);
    assert.match(r.output, /err/);
    assert.equal(r.exitCode, 7);
  });

  it('handles output without a trailing newline, multi-line commands and heredocs', async () => {
    const m = make();
    assert.equal((await m.run('main', 'printf abc', 5000)).output, 'abc');
    const r = await m.run('main', "cat <<'EOF'\nline one\n'quoted' \"double\" $HOME `x`\nEOF\necho done", 5000);
    assert.equal(r.output, "line one\n'quoted' \"double\" $HOME `x`\ndone\n");
  });

  it('is isolated per terminal name', async () => {
    const m = make();
    await m.run('a', 'export WHO=a', 5000);
    await m.run('b', 'export WHO=b', 5000);
    assert.equal((await m.run('a', 'echo $WHO', 5000)).output, 'a\n');
    assert.equal(m.list().length, 2);
  });

  it('serialises concurrent commands in one terminal, in order', async () => {
    const m = make();
    const results = await Promise.all([
      m.run('main', 'sleep 0.2; echo first', 5000),
      m.run('main', 'echo second', 5000),
      m.run('main', 'echo third', 5000),
    ]);
    assert.deepEqual(results.map(r => r.output), ['first\n', 'second\n', 'third\n']);
  });

  it("a command cannot swallow the next command's input", async () => {
    const m = make();
    const r = await m.run('main', 'cat; echo after-cat', 5000);
    assert.equal(r.output, 'after-cat\n');
    assert.equal((await m.run('main', 'echo still-fine', 5000)).output, 'still-fine\n');
  });

  it('output cannot spoof the end marker of another command', async () => {
    const r = await make().run('main', 'echo "\n__EA_END_deadbeef_0__\nstill running"', 5000);
    assert.match(r.output, /still running/);
  });

  it('timeout kills the terminal; the next run gets a fresh shell', async () => {
    const m = make();
    await m.run('main', 'export MARK=old', 5000);
    const r = await m.run('main', 'echo started; sleep 30', 300);
    assert.equal(r.timedOut, true);
    assert.equal(r.terminalClosed, true);
    assert.match(r.output, /started/);
    assert.equal(m.count(), 0);
    const next = await m.run('main', 'echo "[${MARK:-unset}]"', 5000);
    assert.equal(next.output, '[unset]\n');
  });

  it('`exit` inside a command closes the terminal and says so', async () => {
    const m = make();
    const r = await m.run('main', 'echo bye; exit 3', 5000);
    assert.equal(r.terminalClosed, true);
    assert.equal(r.exitCode, null);
    assert.match(r.output, /bye/);
    assert.equal((await m.run('main', 'echo reborn', 5000)).output, 'reborn\n');
  });

  it('truncates huge output but still finds the end of the command', async () => {
    const r = await make({ maxOutputChars: 1000 }).run('main', 'yes x | head -c 50000; echo', 10000);
    assert.equal(r.truncated, true);
    assert.equal(r.exitCode, 0);
    assert.ok(r.output.length < 1200);
    assert.match(r.output, /output truncated/);
  });

  it('enforces the terminal limit and validates names', async () => {
    const m = make({ maxTerminals: 2 });
    await m.run('a', 'true', 5000);
    await m.run('b', 'true', 5000);
    await assert.rejects(m.run('c', 'true', 5000), /Terminal limit reached/);
    await assert.rejects(m.run('bad name', 'true', 5000), /Invalid terminal name/);
    await m.close('a');
    await m.run('c', 'true', 5000);
  });

  it('sweeps idle terminals but never a busy one', async () => {
    let now = 1_000_000;
    const m = make({ idleMs: 60_000, now: () => now });
    await m.run('idle', 'true', 5000);
    const busy = m.run('busy', 'sleep 0.4', 5000);
    await new Promise(r => setTimeout(r, 100));
    now += 120_000;
    const closed = await m.sweepIdle();
    assert.deepEqual(closed, ['idle']);
    assert.equal((await busy).exitCode, 0);
    assert.deepEqual(m.list().map(t => t.name), ['busy']);
  });
});
