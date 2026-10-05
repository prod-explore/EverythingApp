import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDirectory, listViaFind, mimeFor, normalizeWorkspacePath, parseDirectoryTar, readFile, type ArchiveOps } from '../explorer.js';
import { FakeFs, localExec } from './helpers.js';

function opsFor(fs: FakeFs): ArchiveOps & { archives: string[] } {
  const archives: string[] = [];
  return {
    archives,
    async statPath(_id, p) {
      return fs.stat(p);
    },
    async getArchive(_id, p) {
      archives.push(p);
      return fs.archive(p);
    },
  };
}

const sample = () =>
  new FakeFs()
    .file('/workspace/README.md', '# hi')
    .file('/workspace/src/index.ts', 'export {}')
    .file('/workspace/src/deep/x.js', 'x')
    .file('/workspace/node_modules/pkg/index.js', 'big')
    .file('/workspace/.ea-checkpoints/HEAD', 'ref: refs/heads/master')
    .file('/workspace/.ea-checkpoints/actions.log', 'secret-ish')
    .symlink('/workspace/etc-link', '/etc')
    .symlink('/workspace/src/escape', '../../..')
    .file('/workspace/big.bin', Buffer.alloc(3000, 1));

describe('path confinement', () => {
  it('normalizes to absolute paths under /workspace', () => {
    assert.equal(normalizeWorkspacePath(undefined), '/workspace');
    assert.equal(normalizeWorkspacePath(''), '/workspace');
    assert.equal(normalizeWorkspacePath('/workspace/'), '/workspace');
    assert.equal(normalizeWorkspacePath('/workspace//src/./a.ts'), '/workspace/src/a.ts');
    assert.equal(normalizeWorkspacePath('src/a.ts'), '/workspace/src/a.ts');
  });

  it('rejects escapes, .. and the metadata dir', () => {
    for (const bad of ['/etc/passwd', '/', '/workspacex', '/workspace/../etc', '..', 'src/../../etc', '/workspace/a/..', 'a\\..\\..\\etc']) {
      assert.throws(() => normalizeWorkspacePath(bad), (e: { status?: number }) => e.status === 400, bad);
    }
    assert.throws(() => normalizeWorkspacePath('/workspace/.ea-checkpoints/HEAD'), (e: { status?: number }) => e.status === 404);
    assert.throws(() => normalizeWorkspacePath('/workspace/a\0b'), (e: { status?: number }) => e.status === 400);
    assert.throws(() => normalizeWorkspacePath(['x']), (e: { status?: number }) => e.status === 400);
  });
});

describe('directory listing from a real tar stream', () => {
  it('returns direct children only, dirs first, symlinks reported not followed, metadata hidden', async () => {
    const l = await listDirectory(opsFor(sample()), 'c1', '/workspace');
    assert.equal(l.truncated, false);
    assert.deepEqual(
      l.entries.map(e => [e.name, e.type]),
      [
        ['node_modules', 'directory'],
        ['src', 'directory'],
        ['big.bin', 'file'],
        ['etc-link', 'symlink'],
        ['README.md', 'file'],
      ],
    );
    const readme = l.entries.find(e => e.name === 'README.md')!;
    assert.equal(readme.size, 4);
    assert.equal(readme.path, '/workspace/README.md');
    assert.equal(readme.mtime, '2026-01-02T03:04:05.000Z');
    assert.equal(l.entries.find(e => e.name === 'etc-link')!.target, '/etc');
  });

  it('lists a subdirectory', async () => {
    const l = await listDirectory(opsFor(sample()), 'c1', 'src');
    assert.deepEqual(l.entries.map(e => e.name), ['deep', 'escape', 'index.ts']);
    assert.equal(l.path, '/workspace/src');
  });

  it('refuses to traverse or list through a symlink', async () => {
    const ops = opsFor(sample());
    await assert.rejects(listDirectory(ops, 'c1', '/workspace/etc-link'), (e: { status?: number }) => e.status === 400);
    await assert.rejects(listDirectory(ops, 'c1', '/workspace/etc-link/ssh'), /symlink/);
    await assert.rejects(readFile(ops, 'c1', '/workspace/src/escape/etc/passwd', 1000), /symlink/);
    assert.deepEqual(ops.archives, [], 'nothing was fetched');
  });

  it('no container yet → empty listing; missing path → 404; a file → 400', async () => {
    const ops = opsFor(sample());
    assert.deepEqual(await listDirectory(ops, null, '/workspace/src'), { path: '/workspace/src', entries: [], truncated: false, empty: true });
    await assert.rejects(listDirectory(ops, 'c1', '/workspace/nope'), (e: { status?: number }) => e.status === 404);
    await assert.rejects(listDirectory(ops, 'c1', '/workspace/README.md'), (e: { status?: number }) => e.status === 400);
    const gone: ArchiveOps = { statPath: async () => null, getArchive: async () => assert.fail('no archive') };
    assert.equal((await listDirectory(gone, 'c1', '/workspace')).entries.length, 0);
  });

  it('stops scanning at the entry budget and says so', async () => {
    const fs = new FakeFs();
    for (let i = 0; i < 50; i++) fs.file(`/workspace/f${String(i).padStart(2, '0')}`, 'x');
    const l = await parseDirectoryTar(fs.archive('/workspace'), '/workspace', { maxEntries: 10 });
    assert.equal(l.entries.length, 10);
    assert.equal(l.truncated, true);
  });
});

describe('file read', () => {
  it('returns bytes with an extension-based mime type', async () => {
    const f = await readFile(opsFor(sample()), 'c1', '/workspace/src/index.ts', 1000);
    assert.equal(f.data.toString(), 'export {}');
    assert.equal(f.mime, 'text/x-typescript');
    assert.equal(f.size, 9);
    assert.equal(f.name, 'index.ts');
  });

  it('enforces the size cap before transferring anything', async () => {
    const ops = opsFor(sample());
    await assert.rejects(readFile(ops, 'c1', '/workspace/big.bin', 2000), (e: { status?: number }) => e.status === 413);
    assert.deepEqual(ops.archives, []);
    assert.equal((await readFile(ops, 'c1', '/workspace/big.bin', 4000)).data.length, 3000);
  });

  it('directories, symlinks, missing files and no-container are refused', async () => {
    const ops = opsFor(sample());
    await assert.rejects(readFile(ops, 'c1', '/workspace/src', 1000), (e: { status?: number }) => e.status === 400);
    await assert.rejects(readFile(ops, 'c1', '/workspace', 1000), (e: { status?: number }) => e.status === 400);
    await assert.rejects(readFile(ops, 'c1', '/workspace/etc-link', 1000), (e: { status?: number }) => e.status === 400);
    await assert.rejects(readFile(ops, 'c1', '/workspace/nope.txt', 1000), (e: { status?: number }) => e.status === 404);
    await assert.rejects(readFile(ops, null, '/workspace/README.md', 1000), (e: { status?: number }) => e.status === 404);
  });

  it('mime guess by name only', () => {
    assert.equal(mimeFor('a.PNG'), 'image/png');
    assert.equal(mimeFor('Dockerfile'), 'text/plain');
    assert.equal(mimeFor('.env'), 'text/plain');
    assert.equal(mimeFor('noext'), 'application/octet-stream');
    assert.equal(mimeFor('x.unknownext'), 'application/octet-stream');
  });
});

describe('running-sandbox fast path (find inside the container; here: local bash)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ea-find-')).replace(/\\/g, '/');
    mkdirSync(`${dir}/sub dir`);
    writeFileSync(`${dir}/a file.txt`, 'hello');
    if (process.platform !== 'win32') writeFileSync(`${dir}/tab\there`, ''); // NTFS forbids tabs in names
    mkdirSync(`${dir}/.ea-checkpoints`);
    try {
      symlinkSync('/etc', `${dir}/link`);
    } catch {
      /* no symlink permission (Windows) — skip that part */
    }
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('parses NUL-separated find output, odd names included', async () => {
    const l = await listViaFind(async cmd => localExec(cmd), dir);
    const names = l.entries.map(e => e.name);
    assert.ok(names.includes('sub dir'));
    assert.ok(names.includes('a file.txt'));
    if (process.platform !== 'win32') assert.ok(names.includes('tab\there'));
    assert.deepEqual(l.entries.slice(0, 2).map(e => e.type), ['directory', 'directory'], 'directories first');
    const f = l.entries.find(e => e.name === 'a file.txt')!;
    assert.equal(f.type, 'file');
    assert.equal(f.size, 5);
    assert.ok(f.mtime);
    assert.equal(f.path, `${dir}/a file.txt`);
  });

  it('hides the metadata dir only at the workspace root', async () => {
    // At /workspace the meta dir is hidden; the parser works on whatever find prints.
    const out = ['d', '0', '1700000000.5', '755', '', '.ea-checkpoints', 'f', '3', '1700000000', '644', '', 'a', 'l', '4', '1700000000', '777', '/etc', 'lnk', ''].join('\0');
    const l = await listViaFind(async () => ({ stdout: out, stderr: '', exitCode: 0 }), '/workspace');
    assert.deepEqual(l.entries.map(e => [e.name, e.type]), [['a', 'file'], ['lnk', 'symlink']]);
    assert.equal(l.entries[1]!.target, '/etc');
    assert.equal(l.entries[0]!.mode, 0o644);
  });

  it('listDirectory uses the fast path when given exec, without fetching an archive', async () => {
    const ops = opsFor(sample());
    const cmds: string[] = [];
    await listDirectory(ops, 'c1', '/workspace/src', {
      exec: async cmd => {
        cmds.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    assert.equal(cmds.length, 1);
    assert.ok(!cmds[0]!.includes('/workspace/src'), 'path travels base64-encoded');
    assert.deepEqual(ops.archives, []);
  });
});
