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
 * Saves a text file from the Files editor. This is a human action (the user typing in the editor), so it does
 * not go through the agent approval gate; it still only ever runs inside the owner's sandbox and is audit-logged
 * by the caller. Content travels as base64, so no content can break out of the shell command.
 */
export async function writeWorkspaceFile(sandbox: SandboxExec, owner: string, rawPath: string, content: string): Promise<{ path: string; bytes: number }> {
  const path = resolveWorkspacePath(rawPath);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_EDIT_BYTES) throw new WorkspaceWriteError(`file is larger than ${MAX_EDIT_BYTES / 1024} KB — edit it with the agent instead`, 413);
  const dir = path.slice(0, path.lastIndexOf('/'));
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const r = await sandbox.exec(owner, `mkdir -p ${q(dir)} && printf %s ${q(b64)} | base64 -d > ${q(path)}`, 30_000);
  if (r.exitCode !== 0) throw new WorkspaceWriteError(r.stderr.trim().slice(0, 300) || 'write failed', 502);
  return { path, bytes };
}
