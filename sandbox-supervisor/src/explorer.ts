import path from 'node:path';
import tar from 'tar-stream';
import type { Readable } from 'node:stream';

/**
 * Workspace Explorer: read-only access to a sandbox's /workspace for the UI.
 *
 * The host only moves BYTES here. Everything goes through Docker's archive API (`GET/HEAD
 * /containers/:id/archive`), which works on stopped containers too; the tar stream is parsed in Node and
 * nothing from the workspace is ever executed, unpacked to disk or interpreted on the host.
 *
 * Paths are confined to /workspace: `..` is rejected outright, and every component of the requested path
 * is stat'ed first so a symlink anywhere along the way is refused instead of followed. Symlinks inside a
 * listing are reported as type `symlink` (with their target as plain text) and never resolved.
 */

export const WORKSPACE = '/workspace';
/** Supervisor-owned metadata inside the workspace (checkpoint git dir, action log). Hidden from the explorer. */
export const META_DIR_NAME = '.ea-checkpoints';
export const META_DIR = `${WORKSPACE}/${META_DIR_NAME}`;

export interface PathStat {
  name: string;
  size: number;
  /** Go os.FileMode bits as reported by Docker. */
  mode: number;
  mtime: string;
  linkTarget: string;
}

export interface ArchiveOps {
  /** HEAD /archive. null when the path (or the container) does not exist. */
  statPath(containerId: string, path: string): Promise<PathStat | null>;
  /** GET /archive: a tar stream of `path` (recursive for directories). */
  getArchive(containerId: string, path: string): Promise<Readable>;
}

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface DirEntry {
  name: string;
  /** Absolute path inside the sandbox, e.g. /workspace/src/index.ts */
  path: string;
  type: EntryType;
  size: number;
  /** ISO timestamp, when known. */
  mtime: string | null;
  /** Unix permission bits (e.g. 0o644 = 420). */
  mode: number;
  /** Only for symlinks: the link text. Never resolved. */
  target?: string;
}

export interface Listing {
  path: string;
  entries: DirEntry[];
  /** The scan stopped early (entry or byte budget); the listing may be incomplete. */
  truncated: boolean;
  /** No container exists for this owner yet. */
  empty?: boolean;
}

export class ExplorerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const GO_MODE_DIR = 2 ** 31;
const GO_MODE_SYMLINK = 2 ** 27;
const bit = (mode: number, b: number) => Math.floor(mode / b) % 2 === 1;
export const isSymlinkStat = (s: PathStat) => bit(s.mode, GO_MODE_SYMLINK) || !!s.linkTarget;
export const isDirStat = (s: PathStat) => bit(s.mode, GO_MODE_DIR);

/**
 * Normalize a user-supplied path to an absolute path under /workspace, or throw ExplorerError(400).
 * Relative paths are taken relative to /workspace. Any `..` segment is rejected (not resolved), as is
 * anything inside the supervisor's metadata dir.
 */
export function normalizeWorkspacePath(input: unknown): string {
  if (input === undefined || input === '') return WORKSPACE;
  if (typeof input !== 'string') throw new ExplorerError('path must be a string', 400);
  if (input.length > 4096 || input.includes('\0')) throw new ExplorerError('invalid path', 400);
  const raw = input.replace(/\\/g, '/');
  if (raw.split('/').includes('..')) throw new ExplorerError('path must not contain ".."', 400);
  const abs = path.posix.normalize(raw.startsWith('/') ? raw : `${WORKSPACE}/${raw}`).replace(/\/+$/, '') || '/';
  if (abs !== WORKSPACE && !abs.startsWith(`${WORKSPACE}/`)) {
    throw new ExplorerError(`path must be inside ${WORKSPACE}`, 400);
  }
  const rel = abs.slice(WORKSPACE.length + 1);
  if (rel.split('/')[0] === META_DIR_NAME) throw new ExplorerError('path not found', 404);
  return abs;
}

/**
 * Stat every component from /workspace down to `abs` and refuse if any of them is a symlink.
 * Returns the stat of `abs` itself, or null if some component does not exist.
 */
export async function statNoFollow(ops: ArchiveOps, containerId: string, abs: string): Promise<PathStat | null> {
  const parts = abs === WORKSPACE ? [] : abs.slice(WORKSPACE.length + 1).split('/');
  let cur = WORKSPACE;
  let stat = await ops.statPath(containerId, cur);
  if (!stat) return null;
  for (const part of parts) {
    if (isSymlinkStat(stat)) throw new ExplorerError(`${cur} is a symlink; symlinks are not followed`, 400);
    cur = `${cur}/${part}`;
    stat = await ops.statPath(containerId, cur);
    if (!stat) return null;
  }
  if (isSymlinkStat(stat)) throw new ExplorerError(`${abs} is a symlink; symlinks are not followed`, 400);
  return stat;
}

function entryType(t: tar.Header['type']): EntryType {
  if (t === 'file' || t === 'contiguous-file') return 'file';
  if (t === 'directory') return 'directory';
  if (t === 'symlink') return 'symlink';
  return 'other';
}

export interface ListOptions {
  /** Max direct children returned. */
  maxEntries?: number;
  /** Max tar bytes scanned (a directory archive is recursive, so a huge subtree costs this much). */
  maxScanBytes?: number;
}

/**
 * Feed `source` into a tar extractor by hand (with backpressure) instead of `pipe()`, so this works the
 * same for Docker's http response and for any other readable. Returns a function that aborts both.
 */
function feed(source: Readable, extract: tar.Extract, onError: (e: Error) => void): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    source.destroy();
    extract.destroy();
  };
  source.on('data', (c: Buffer) => {
    if (stopped) return;
    if (!extract.write(c)) {
      source.pause();
      extract.once('drain', () => !stopped && source.resume());
    }
  });
  source.on('end', () => !stopped && (extract as unknown as { end(): void }).end());
  source.on('error', (e: Error) => onError(e));
  extract.on('error', (e: Error) => onError(e));
  return stop;
}

/**
 * Parse a directory archive (as produced by Docker for `abs`) into its DIRECT children.
 * Docker names entries `<basename>/...`; deeper entries are drained and skipped.
 */
export function parseDirectoryTar(stream: Readable, abs: string, opts: ListOptions = {}): Promise<Listing> {
  const maxEntries = opts.maxEntries ?? 5000;
  const maxScanBytes = opts.maxScanBytes ?? 256 * 1024 * 1024;
  const base = path.posix.basename(abs);
  const atRoot = abs === WORKSPACE;
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const entries: DirEntry[] = [];
    let scanned = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      stop();
      sortEntries(entries);
      resolve({ path: abs, entries, truncated });
    };
    const stop = feed(stream, extract, err => {
      if (done) return;
      done = true;
      stop();
      reject(err);
    });
    stream.on('data', (c: Buffer) => {
      scanned += c.length;
      if (scanned > maxScanBytes) finish(true);
    });
    extract.on('entry', (header, body, next) => {
      if (done) return;
      const parts = header.name.replace(/\/+$/, '').split('/');
      if (parts.length === 2 && parts[0] === base && parts[1] && !(atRoot && parts[1] === META_DIR_NAME)) {
        const type = entryType(header.type);
        entries.push({
          name: parts[1],
          path: `${abs}/${parts[1]}`,
          type,
          size: type === 'file' ? (header.size ?? 0) : 0,
          mtime: header.mtime ? header.mtime.toISOString() : null,
          mode: (header.mode ?? 0) & 0o7777,
          ...(type === 'symlink' ? { target: header.linkname ?? '' } : {}),
        });
        if (entries.length >= maxEntries) {
          finish(true);
          return;
        }
      }
      body.on('end', () => next());
      body.resume();
    });
    extract.on('finish', () => finish(false));
  });
}

export interface FileResult {
  path: string;
  name: string;
  size: number;
  mime: string;
  data: Buffer;
}

/** Read one regular file out of a single-entry archive, refusing anything over `maxBytes`. */
export function parseFileTar(stream: Readable, abs: string, maxBytes: number): Promise<FileResult> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      stop();
      reject(e);
    };
    const stop = feed(stream, extract, fail);
    extract.on('entry', (header, body) => {
      if (settled) return;
      const type = entryType(header.type);
      if (type === 'directory') return fail(new ExplorerError(`${abs} is a directory`, 400));
      if (type === 'symlink') return fail(new ExplorerError(`${abs} is a symlink; symlinks are not followed`, 400));
      if (type !== 'file') return fail(new ExplorerError(`${abs} is not a regular file`, 400));
      const size = header.size ?? 0;
      if (size > maxBytes) return fail(new ExplorerError(`file is ${size} bytes; the limit is ${maxBytes}`, 413));
      const chunks: Buffer[] = [];
      body.on('data', (c: unknown) => chunks.push(c as Buffer));
      body.on('end', () => {
        if (settled) return;
        settled = true;
        stop();
        const name = path.posix.basename(abs);
        resolve({ path: abs, name, size, mime: mimeFor(name), data: Buffer.concat(chunks) });
      });
    });
    extract.on('finish', () => fail(new ExplorerError('path not found', 404)));
  });
}

const MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'application/xml', svg: 'image/svg+xml',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript', ts: 'text/x-typescript', tsx: 'text/x-typescript',
  json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', ini: 'text/plain', env: 'text/plain',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java', kt: 'text/x-kotlin', c: 'text/x-c', h: 'text/x-c',
  cpp: 'text/x-c++', hpp: 'text/x-c++', cs: 'text/x-csharp', php: 'text/x-php', sh: 'text/x-shellscript', bash: 'text/x-shellscript', sql: 'application/sql',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', wasm: 'application/wasm',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.dockerignore', '.editorconfig', '.npmrc']);

/** MIME type guessed from the file name ONLY (content is never inspected). */
export function mimeFor(name: string): string {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return 'text/plain';
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot + 1);
  return MIME[ext] ?? 'application/octet-stream';
}

export type ExecFn = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Fast path for a RUNNING sandbox: `find -maxdepth 1` executed INSIDE the container (never on the host).
 * A directory archive is recursive, so listing /workspace through the archive API would stream all of
 * node_modules; this only reads one directory. Fields are NUL-separated, so no file name can break parsing.
 */
export async function listViaFind(exec: ExecFn, abs: string, opts: ListOptions = {}): Promise<Listing> {
  const maxEntries = opts.maxEntries ?? 5000;
  const b64 = Buffer.from(abs, 'utf8').toString('base64');
  const r = await exec(
    `p="$(printf %s '${b64}' | base64 -d)"; find "$p" -mindepth 1 -maxdepth 1 -printf '%y\\0%s\\0%T@\\0%m\\0%l\\0%f\\0'`,
  );
  if (r.exitCode !== 0) throw new Error(`find failed (${r.exitCode}): ${r.stderr.trim()}`);
  const f = r.stdout.split('\0');
  const entries: DirEntry[] = [];
  let truncated = false;
  for (let i = 0; i + 5 < f.length; i += 6) {
    const [y, size, mtime, mode, link, name] = f.slice(i, i + 6) as [string, string, string, string, string, string];
    if (abs === WORKSPACE && name === META_DIR_NAME) continue;
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const type: EntryType = y === 'f' ? 'file' : y === 'd' ? 'directory' : y === 'l' ? 'symlink' : 'other';
    const t = parseFloat(mtime);
    entries.push({
      name,
      path: `${abs}/${name}`,
      type,
      size: type === 'file' ? parseInt(size, 10) || 0 : 0,
      mtime: Number.isFinite(t) ? new Date(t * 1000).toISOString() : null,
      mode: parseInt(mode, 8) || 0,
      ...(type === 'symlink' ? { target: link } : {}),
    });
  }
  sortEntries(entries);
  return { path: abs, entries, truncated };
}

function sortEntries(entries: DirEntry[]): void {
  entries.sort((a, b) =>
    a.type === 'directory' && b.type !== 'directory' ? -1 : b.type === 'directory' && a.type !== 'directory' ? 1 : a.name.localeCompare(b.name),
  );
}

/**
 * List a directory. `containerId` null = no container yet = empty listing. If `exec` is given (the sandbox
 * is running) the in-container `find` fast path is used; otherwise the archive API (works when stopped).
 */
export async function listDirectory(
  ops: ArchiveOps,
  containerId: string | null,
  input: unknown,
  opts: ListOptions & { exec?: ExecFn } = {},
): Promise<Listing> {
  const abs = normalizeWorkspacePath(input);
  if (!containerId) return { path: abs, entries: [], truncated: false, empty: true };
  const stat = await statNoFollow(ops, containerId, abs);
  if (!stat) {
    if (abs === WORKSPACE) return { path: abs, entries: [], truncated: false, empty: true };
    throw new ExplorerError('path not found', 404);
  }
  if (!isDirStat(stat)) throw new ExplorerError(`${abs} is not a directory`, 400);
  if (opts.exec) return listViaFind(opts.exec, abs, opts);
  return parseDirectoryTar(await ops.getArchive(containerId, abs), abs, opts);
}

/** Read a regular file (bytes), capped at `maxBytes`. */
export async function readFile(ops: ArchiveOps, containerId: string | null, input: unknown, maxBytes: number): Promise<FileResult> {
  const abs = normalizeWorkspacePath(input);
  if (abs === WORKSPACE) throw new ExplorerError(`${abs} is a directory`, 400);
  if (!containerId) throw new ExplorerError('path not found', 404);
  const stat = await statNoFollow(ops, containerId, abs);
  if (!stat) throw new ExplorerError('path not found', 404);
  if (isDirStat(stat)) throw new ExplorerError(`${abs} is a directory`, 400);
  if (stat.size > maxBytes) throw new ExplorerError(`file is ${stat.size} bytes; the limit is ${maxBytes}`, 413);
  return parseFileTar(await ops.getArchive(containerId, abs), abs, maxBytes);
}
