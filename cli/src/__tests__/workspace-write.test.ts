import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspacePath, writeWorkspaceFile, MAX_EDIT_BYTES } from '../workspace-write.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Files editor write path', () => {
  it('confines paths to /workspace and blocks .git', () => {
    assert.equal(resolveWorkspacePath('src/a.ts'), '/workspace/src/a.ts');
    assert.equal(resolveWorkspacePath('/workspace/a/../b.txt'), '/workspace/b.txt');
    for (const bad of ['../etc/passwd', '/etc/passwd', '/workspace', '/workspace/../x', '/workspace/.git/config', 'a\nb', '']) {
      assert.throws(() => resolveWorkspacePath(bad), /path|invalid|\.git/, bad);
    }
  });

  it('round-trips awkward content through the real shell command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    const content = `it's "quoted" $(rm -rf /) \`id\` ;\n\tünïcødé 🚀\n`;
    const bashBin = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
      ? 'C:\\Program Files\\Git\\bin\\bash.exe'
      : 'bash';
    const sandbox = { exec: async (_o: string, cmd: string) => {
      // Run the exact command, with /workspace remapped to a temp dir.
      execFileSync(bashBin, ['-c', cmd.replaceAll('/workspace', dir.replace(/\\/g, '/'))]);
      return { stdout: '', stderr: '', exitCode: 0 };
    } };
    const r = await writeWorkspaceFile(sandbox, 'o', 'deep/dir/file with space.txt', content);
    assert.equal(r.path, '/workspace/deep/dir/file with space.txt');
    assert.equal(readFileSync(join(dir, 'deep/dir/file with space.txt'), 'utf8'), content);
  });

  it('refuses oversized files and surfaces shell errors', async () => {
    const ok = { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    await assert.rejects(writeWorkspaceFile(ok, 'o', 'a.txt', 'x'.repeat(MAX_EDIT_BYTES + 1)), /larger/);
    const bad = { exec: async () => ({ stdout: '', stderr: 'disk full', exitCode: 1 }) };
    await assert.rejects(writeWorkspaceFile(bad, 'o', 'a.txt', 'x'), /disk full/);
  });
});
