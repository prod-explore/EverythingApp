import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Llm from '../llm-types.js';
import { fileTools, miniDiff } from '../file-tools.js';
import { writeWorkspaceFile } from '../workspace-write.js';
import type { SandboxExec } from '../supervisor-client.js';
import { getMessages, logApprovalAudit, openDb, redactSecrets, runMigrations } from '../db.js';
import { DEFAULT_COMMAND_POLICY, evaluateCommand, splitShellCommand, type CommandPolicy } from '../command-policy.js';
import { KeyVault } from '../providers/key-vault.js';
import { ProviderRouter } from '../providers/router.js';
import { buildApp } from '../server.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const bashBin = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';

/** A "sandbox" that runs the real command with /workspace remapped to a temp dir. */
function tempSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ea-ws-'));
  const sizes: number[] = [];
  const sandbox: SandboxExec = {
    exec: async (_o, cmd) => {
      sizes.push(cmd.length);
      try {
        execFileSync(bashBin, ['-c', cmd.replaceAll('/workspace', dir.replace(/\\/g, '/'))], { stdio: 'pipe' });
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (e) {
        return { stdout: '', stderr: String((e as { stderr?: Buffer }).stderr ?? e), exitCode: 1 };
      }
    },
  };
  const readFile = async (_o: string, p: string): Promise<Buffer> => {
    const f = join(dir, p.replace(/^\/workspace/, ''));
    if (!existsSync(f)) throw new Error('no such file');
    return readFileSync(f);
  };
  return { dir, sandbox, readFile, sizes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tools = (t: ReturnType<typeof tempSandbox>, writes: unknown[] = []) => {
  const list = fileTools({ owner: 'o', sandbox: t.sandbox, readFile: t.readFile, onWrite: w => writes.push(w) });
  const by = Object.fromEntries(list.map(x => [x.definition.name, x]));
  const ctx = { toolUseId: 'x' };
  return {
    list,
    read: (i: Record<string, unknown>) => by['read_file']!.handler(i, ctx),
    write: (i: Record<string, unknown>) => by['write_file']!.handler(i, ctx),
    edit: (i: Record<string, unknown>) => by['edit_file']!.handler(i, ctx),
  };
};

// ─── writing files ───────────────────────────────────────────────────────────

describe('workspace file writes', () => {
  it('sends a big file in several small commands and the bytes arrive intact', async () => {
    const t = tempSandbox();
    try {
      const content = Array.from({ length: 6000 }, (_, i) => `line ${i} — zażółć gęślą jaźń 🚀 it's "q" $(x)`).join('\n');
      assert.ok(Buffer.byteLength(content) > 200_000);
      await writeWorkspaceFile(t.sandbox, 'o', 'big/file.txt', content);
      assert.equal(readFileSync(join(t.dir, 'big/file.txt'), 'utf8'), content);
      assert.ok(t.sizes.length > 4, 'split into chunks');
      assert.ok(Math.max(...t.sizes) < 60_000, `every command stays small (max ${Math.max(...t.sizes)})`);
      assert.deepEqual(readdirNames(join(t.dir, 'big')), ['file.txt'], 'no temp files left behind');
    } finally { t.cleanup(); }
  });

  it('replaces atomically, keeps the mode of an existing file and writes an empty file', async () => {
    const t = tempSandbox();
    try {
      mkdirSync(join(t.dir, 'bin'));
      writeFileSync(join(t.dir, 'bin/run.sh'), 'old');
      chmodSync(join(t.dir, 'bin/run.sh'), 0o755);
      await writeWorkspaceFile(t.sandbox, 'o', 'bin/run.sh', '#!/bin/sh\necho new\n');
      assert.equal(readFileSync(join(t.dir, 'bin/run.sh'), 'utf8'), '#!/bin/sh\necho new\n');
      assert.equal(statSync(join(t.dir, 'bin/run.sh')).mode & 0o777, 0o755);
      await writeWorkspaceFile(t.sandbox, 'o', 'empty.txt', '');
      assert.equal(readFileSync(join(t.dir, 'empty.txt'), 'utf8'), '');
    } finally { t.cleanup(); }
  });

  it('cleans up the staging files when a step fails', async () => {
    const cmds: string[] = [];
    const sandbox: SandboxExec = { exec: async (_o, c) => { cmds.push(c); return /base64 -d/.test(c) ? { stdout: '', stderr: 'disk full', exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 }; } };
    await assert.rejects(writeWorkspaceFile(sandbox, 'o', 'a.txt', 'hello'), /disk full/);
    assert.match(cmds[cmds.length - 1]!, /rm -f/);
  });
});

function readdirNames(dir: string): string[] {
  return execFileSync(bashBin, ['-c', `ls -A '${dir.replace(/\\/g, '/')}'`]).toString().split('\n').filter(Boolean).sort();
}

// ─── read_file / write_file / edit_file ──────────────────────────────────────

describe('file tools for the agent', () => {
  it('need no approval, and only the reader is allowed in plan mode', () => {
    const t = tempSandbox();
    try {
      const { list } = tools(t);
      assert.deepEqual(list.map(x => x.definition.name), ['read_file', 'edit_file', 'write_file']);
      for (const x of list) assert.equal(x.requiresApproval, undefined, x.definition.name);
      assert.deepEqual(list.map(x => x.planSafe), [true, false, false]);
    } finally { t.cleanup(); }
  });

  it('write_file creates a file (and its folders), read_file numbers the lines and pages through long files', async () => {
    const t = tempSandbox();
    const writes: unknown[] = [];
    try {
      const f = tools(t, writes);
      const w = await f.write({ path: 'notes/todo.md', content: 'a\nb\nc\n' });
      assert.match(w.text, /Saved \/workspace\/notes\/todo\.md \(6 bytes\)/);
      assert.deepEqual(writes, [{ action: 'write_file', path: '/workspace/notes/todo.md', bytes: 6 }]);
      assert.equal((await f.read({ path: 'notes/todo.md' })).text, '     1\ta\n     2\tb\n     3\tc');

      await f.write({ path: 'long.txt', content: Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join('\n') });
      const page = await f.read({ path: 'long.txt', offset: 10, limit: 5 });
      assert.match(page.text, /^ {4}10\tl10\n/);
      assert.match(page.text, /\[… 36 more lines — continue with offset 15\]$/);
      assert.equal((await f.read({ path: 'long.txt', offset: 99 })).isError, true);
      assert.equal((await f.read({ path: 'nope.txt' })).text, 'File not found: /workspace/nope.txt');
    } finally { t.cleanup(); }
  });

  it('edit_file replaces a unique match, shows what changed, and explains every refusal', async () => {
    const t = tempSandbox();
    const writes: unknown[] = [];
    try {
      const f = tools(t, writes);
      await f.write({ path: 'a.ts', content: 'const a = 1;\nconst b = 2;\nconst c = 2;\n' });
      writes.length = 0;

      const ok = await f.edit({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = $& + "$1";' });
      assert.equal(ok.isError, undefined);
      assert.match(ok.text, /Edited \/workspace\/a\.ts: 1 replacement\.\n@@ line 1 @@\n- const a = 1;\n\+ const a = \$& \+ "\$1";/);
      assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'const a = $& + "$1";\nconst b = 2;\nconst c = 2;\n', 'replacement text is literal');
      assert.equal(writes.length, 1);

      const dup = await f.edit({ path: 'a.ts', old_string: ' = 2;', new_string: ' = 3;' });
      assert.equal(dup.isError, true);
      assert.match(dup.text, /occurs 2 times/);
      assert.match((await f.edit({ path: 'a.ts', old_string: ' = 2;', new_string: ' = 3;', replace_all: true })).text, /2 replacements/);
      assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'const a = $& + "$1";\nconst b = 3;\nconst c = 3;\n');

      assert.match((await f.edit({ path: 'a.ts', old_string: 'zzz', new_string: 'y' })).text, /not found/);
      assert.match((await f.edit({ path: 'a.ts', old_string: 'x', new_string: 'x' })).text, /identical/);
      assert.match((await f.edit({ path: 'a.ts', old_string: '', new_string: 'x' })).text, /non-empty/);
      assert.match((await f.edit({ path: 'missing.ts', old_string: 'x', new_string: 'y' })).text, /File not found/);
      assert.equal(writes.length, 2, 'refused edits are not logged as writes');
    } finally { t.cleanup(); }
  });

  it('stay inside /workspace, away from .git, and off binary files', async () => {
    const t = tempSandbox();
    try {
      const f = tools(t);
      for (const path of ['../etc/passwd', '/etc/passwd', '/workspace/.git/config', '']) {
        assert.equal((await f.write({ path, content: 'x' })).isError, true, path);
        assert.equal((await f.edit({ path, old_string: 'a', new_string: 'b' })).isError, true, path);
        assert.equal((await f.read({ path })).isError, true, path);
      }
      assert.equal((await f.write({ path: 'a.txt', content: 'a\0b' })).isError, true);
      writeFileSync(join(t.dir, 'img.bin'), Buffer.from([1, 2, 0, 3]));
      assert.match((await f.read({ path: 'img.bin' })).text, /binary/);
      assert.match((await f.edit({ path: 'img.bin', old_string: 'a', new_string: 'b' })).text, /binary/);
    } finally { t.cleanup(); }
  });

  it('miniDiff shows only the changed lines and clips long diffs', () => {
    assert.equal(miniDiff('a\nb\nc', 'a\nB\nc'), '@@ line 2 @@\n- b\n+ B');
    const big = miniDiff('x', Array.from({ length: 100 }, (_, i) => `n${i}`).join('\n'));
    assert.match(big, /… \(\d+ more changed lines\)$/);
  });
});

// ─── server wiring ───────────────────────────────────────────────────────────

const TOKEN = 't';
function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      res => {
        const c: Buffer[] = [];
        res.on('data', d => c.push(d));
        res.on('end', () => { const s = Buffer.concat(c).toString(); resolve({ status: res.statusCode ?? 0, json: s ? JSON.parse(s) : {} }); });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
async function poll(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 15)); }
}

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null };
const msg = (content: unknown[], stop: Llm.StopReason): Llm.Message =>
  ({ id: 'm', content, model: '@t/m', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;

describe('server: the agent edits files without being asked', () => {
  it('edit_file and write_file run straight away in a sandbox chat, are audit-logged, and are missing from chats without a sandbox', async () => {
    const ws = tempSandbox();
    writeFileSync(join(ws.dir, 'hello.txt'), 'hello world\n');
    // The orchestrator reads files through the supervisor's HTTP API.
    const supervisor = http.createServer(async (rq, rs) => {
      const u = new URL(rq.url ?? '/', 'http://x');
      if (u.pathname.endsWith('/file')) {
        try { const b = await ws.readFile('o', u.searchParams.get('path') ?? ''); rs.setHeader('content-type', 'text/plain'); rs.end(b); } catch { rs.statusCode = 404; rs.setHeader('content-type', 'application/json'); rs.end('{"error":"no such file"}'); }
        return;
      }
      rs.setHeader('content-type', 'application/json');
      rs.end('{}');
    });
    await new Promise<void>(r => supervisor.listen(0, r));
    process.env['SUPERVISOR_URL'] = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`;

    const seenTools: string[][] = [];
    let step = 0;
    const client = {
      messages: {
        async create(p: Llm.MessageCreateParamsNonStreaming) {
          seenTools.push((p.tools ?? []).map(x => x.name));
          step++;
          if (step === 1) return msg([{ type: 'tool_use', id: 'e1', name: 'edit_file', input: { path: 'hello.txt', old_string: 'world', new_string: 'there' } }, { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'new/dir/x.md', content: '# x\n' } }], 'tool_use');
          return msg([{ type: 'text', text: 'done' }], 'end_turn');
        },
      },
    };
    const db = openDb(':memory:');
    runMigrations(db);
    const router = new ProviderRouter({ db, env: {}, llmOverride: client as any });
    router.catalog.create({ slug: 't', label: 'Test', baseUrl: 'https://t.example/v1', keyOptional: true, flavor: 'generic' });
    router.catalog.addManual('t', 'm', { tags: [] });
    const built = await buildApp({ db, connections: [], router, authToken: TOKEN, config: { model: '', autoApproveTools: [] }, sandboxExec: ws.sandbox });
    const server = built.app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const conv = (await req(port, 'POST', '/api/conversations', { model: '@t/m', sandboxEnabled: true })).json.id as string;
      await req(port, 'POST', `/api/conversations/${conv}/message`, { text: 'change it' });
      await poll(() => getMessages(db, conv).some(m => JSON.stringify(m.content).includes('done')));

      assert.equal(readFileSync(join(ws.dir, 'hello.txt'), 'utf8'), 'hello there\n');
      assert.equal(readFileSync(join(ws.dir, 'new/dir/x.md'), 'utf8'), '# x\n');
      assert.ok(seenTools[0]!.includes('edit_file') && seenTools[0]!.includes('read_file') && seenTools[0]!.includes('write_file'));
      const audit = db.prepare(`SELECT action, tool_label FROM approval_audit WHERE action = 'agent_file_edit' ORDER BY tool_label`).all();
      assert.deepEqual(audit, [{ action: 'agent_file_edit', tool_label: 'edit_file /workspace/hello.txt' }, { action: 'agent_file_edit', tool_label: 'write_file /workspace/new/dir/x.md' }]);

      // a chat without a sandbox has no workspace, so no file tools
      step = 1;
      const plain = (await req(port, 'POST', '/api/conversations', { model: '@t/m' })).json.id as string;
      await req(port, 'POST', `/api/conversations/${plain}/message`, { text: 'hi' });
      await poll(() => seenTools.length >= 3);
      assert.equal(seenTools[seenTools.length - 1]!.includes('edit_file'), false);
    } finally {
      built.stop(); server.close(); db.close(); supervisor.close(); ws.cleanup();
      delete process.env['SUPERVISOR_URL'];
    }
  });
});


// ─── findings from the audit that still applied ──────────────────────────────

describe('command policy: parsing the audit could get around', () => {
  const allowlist: CommandPolicy = { ...DEFAULT_COMMAND_POLICY, mode: 'allowlist' };
  const auto: CommandPolicy = { ...DEFAULT_COMMAND_POLICY, mode: 'auto' };
  const no = () => false;

  it('ANSI-C quoting $\'…\' cannot hide a second command behind an "echo"', () => {
    const cmd = "echo $'\\''; rm -rf x; echo $'\\''";
    assert.deepEqual(splitShellCommand(cmd).map(c => c.split(' ')[0]), ['echo', 'rm', 'echo']);
    assert.equal(evaluateCommand(cmd, allowlist, no).decision, 'ask');
    assert.equal(evaluateCommand("echo $'a b' && ls", allowlist, no).decision, 'allow', 'plain ANSI-C strings are still fine');
  });

  it('text nested too deeply to analyse asks instead of being waved through', () => {
    const deep = `echo ${'$('.repeat(10)}ls; rm plik${')'.repeat(10)}`;
    assert.equal(evaluateCommand(deep, auto, no).decision, 'ask');
    assert.equal(evaluateCommand('echo $(echo $(ls))', allowlist, no).decision, 'allow', 'ordinary nesting is unaffected');
    let bashDeep = 'ls';
    for (let n = 0; n < 7; n++) bashDeep = `bash -c ${JSON.stringify(bashDeep)}`;
    assert.notEqual(evaluateCommand(bashDeep, auto, no).decision, 'allow');
  });

  it('the always-blocked list sees through quotes, binary paths and long options', () => {
    for (const cmd of ["'rm' -rf /", 'rm -rf "/"', '/bin/rm -rf /', 'rm --no-preserve-root -rf /', '\\rm -rf ~']) {
      assert.equal(evaluateCommand(cmd, auto, no).decision, 'deny', cmd);
    }
    assert.equal(evaluateCommand('rm -rf build', auto, no).decision, 'allow');
  });
});

describe('secrets stay out of the audit trail', () => {
  it('redacts tokens, passwords and keys in logged arguments', () => {
    const raw = JSON.stringify({ command: 'curl -H "Authorization: Bearer abcdef1234567890XYZ" https://u:hunter2@host/x?api_key=sekret123 && export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789 password=topsecret sk-abcdefghijklmnopqrstu' }); // gitleaks:allow — made-up fixture
    const out = redactSecrets(raw);
    for (const leak of ['abcdef1234567890XYZ', 'hunter2', 'sekret123', 'ghp_abcdefghij', 'topsecret', 'sk-abcdefghijk']) assert.equal(out.includes(leak), false, leak);
    assert.match(out, /curl -H/);
    assert.equal(redactSecrets('ls -la /workspace'), 'ls -la /workspace');

    const db = openDb(':memory:');
    runMigrations(db);
    logApprovalAudit(db, { action: 'x', toolLabel: 'run_bash', toolArgs: raw });
    const row = db.prepare(`SELECT tool_args FROM approval_audit`).get() as { tool_args: string };
    assert.equal(row.tool_args.includes('hunter2'), false);
    db.close();
  });
});

describe('key vault', () => {
  it('reads the same key repeatedly (the derived key is cached per stored key) and still fails closed on a wrong secret', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const v = new KeyVault(db, 's'.repeat(40));
    v.set('p', 'secret-value-1234');
    const a = v.read('p');
    const b = v.read('p');
    assert.deepEqual([a.status, b.status], ['ok', 'ok']);
    assert.equal((b as { key: string }).key, 'secret-value-1234');
    assert.equal(new KeyVault(db, 'x'.repeat(40)).read('p').status, 'undecryptable');
    db.close();
  });
});
