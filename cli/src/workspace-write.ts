import { randomBytes } from 'node:crypto';
import type { SandboxExec } from './supervisor-client.js';

export const MAX_EDIT_BYTES = 512 * 1024;

export class WorkspaceWriteError extends Error {
  constructor(message: string, readonly status: number = 400) { super(message); }
}

/** Normalizes to an absolute path inside /workspace; rejects traversal, control characters and the root itself. */
export function resolveWorkspacePath(raw: string): string {
  if (typeof raw !== 'string' || !raw || /[\0\r\n]/.test(raw)) throw new WorkspaceWriteError('invalid path');
  const joined = raw.startsWith('/') ? raw : `/workspace/${raw}`;
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const path = '/' + parts.join('/');
  if (!path.startsWith('/workspace/') || path === '/workspace/') throw new WorkspaceWriteError('path must be a file inside /workspace');
  if (parts.includes('.git')) throw new WorkspaceWriteError('editing .git internals is not allowed');
  return path;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One exec carries at most this much base64: a command is a single argv entry for `bash -c` (the kernel caps one
 * argument at 128 KiB) inside a JSON body (the supervisor's default parser caps that at 100 KB). Bigger files are
 * therefore sent in several appends.
 */
const CHUNK_B64 = 40_000;

/**
 * Writes bytes to a file inside the owner's sandbox: staged next to the target in chunks, then moved into place in
 * one step — an interrupted write never leaves a half-written file. Keeps the mode of an existing file. Content
 * travels as base64, so nothing in it can break out of the shell command.
 */
async function putFile(sandbox: SandboxExec, owner: string, path: string, data: Buffer): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const tmp = `${path}.ea-${randomBytes(4).toString('hex')}.tmp`;
  const b64 = data.toString('base64');
  const fail = async (stderr: string): Promise<never> => {
    await sandbox.exec(owner, `rm -f ${q(tmp)} ${q(tmp + '.b64')}`, 10_000).catch(() => undefined);
    throw new WorkspaceWriteError(stderr.trim().slice(0, 300) || 'write failed', 502);
  };
  for (let at = 0; at === 0 || at < b64.length; at += CHUNK_B64) {
    const part = b64.slice(at, at + CHUNK_B64);
    const r = await sandbox.exec(owner, `${at === 0 ? `mkdir -p ${q(dir)} && ` : ''}printf %s ${q(part)} ${at === 0 ? '>' : '>>'} ${q(tmp + '.b64')}`, 30_000);
    if (r.exitCode !== 0) return fail(r.stderr);
  }
  const done = await sandbox.exec(
    owner,
    `base64 -d ${q(tmp + '.b64')} > ${q(tmp)} && { if [ -f ${q(path)} ]; then m=$(stat -c %a ${q(path)} 2>/dev/null) && chmod "$m" ${q(tmp)}; fi; true; } && mv -f ${q(tmp)} ${q(path)}; rc=$?; rm -f ${q(tmp)} ${q(tmp + '.b64')}; exit $rc`,
    30_000,
  );
  if (done.exitCode !== 0) throw new WorkspaceWriteError(done.stderr.trim().slice(0, 300) || 'write failed', 502);
}

/**
 * Saves a text file. Used by the Files editor (a human typing) and by the agent's write_file / edit_file — neither goes
 * through the approval gate: editing a text file in the workspace is the everyday case, it only ever runs inside the
 * owner's sandbox, a checkpoint is taken before every turn, and the caller audit-logs it.
 */
export async function writeWorkspaceFile(sandbox: SandboxExec, owner: string, rawPath: string, content: string): Promise<{ path: string; bytes: number }> {
  const path = resolveWorkspacePath(rawPath);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_EDIT_BYTES) throw new WorkspaceWriteError(`file is larger than ${MAX_EDIT_BYTES / 1024} KB — edit it with the agent instead`, 413);
  await putFile(sandbox, owner, path, Buffer.from(content, 'utf8'));
  return { path, bytes };
}
