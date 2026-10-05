// Git pkt-line helpers: parsing the receive-pack command section and building report-status replies.
// Format reference: gitprotocol-common(5), gitprotocol-pack(5).
import type { Readable } from 'node:stream';

export const FLUSH_PKT = Buffer.from('0000', 'latin1');
const MAX_PKT_LEN = 65520;

export class PktLineError extends Error {}

export interface RefCommand {
  old: string;
  new: string;
  ref: string;
}

export interface CommandSection {
  commands: RefCommand[];
  capabilities: string[];
  shallow: string[];
}

export type ParseResult = { done: false } | { done: true; section: CommandSection; end: number };

export const isZeroSha = (sha: string): boolean => /^0+$/.test(sha);

export function encodePkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > MAX_PKT_LEN) throw new PktLineError(`pkt-line too long (${len})`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'latin1'), payload]);
}

const SHA = '[0-9a-f]{40}|[0-9a-f]{64}';
const COMMAND_RE = new RegExp(`^(${SHA}) (${SHA}) (\\S.*)$`);

/**
 * Parses the receive-pack request command section (everything up to and including the first flush-pkt):
 *   [shallow <sha>]*  <old> <new> <ref>\0<capabilities>  [<old> <new> <ref>]*  0000
 * Returns {done:false} if `buf` doesn't contain the whole section yet. Throws PktLineError on garbage.
 */
export function parseCommandSection(buf: Buffer): ParseResult {
  let off = 0;
  const commands: RefCommand[] = [];
  const shallow: string[] = [];
  let capabilities: string[] = [];
  for (;;) {
    if (buf.length - off < 4) return { done: false };
    const hex = buf.toString('latin1', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PktLineError('invalid pkt-line length header');
    const len = parseInt(hex, 16);
    if (len === 0) return { done: true, section: { commands, capabilities, shallow }, end: off + 4 };
    if (len < 4) throw new PktLineError(`unexpected special pkt-line ${hex} in command section`);
    if (buf.length - off < len) return { done: false };
    let text = buf.toString('utf8', off + 4, off + len);
    off += len;
    if (text.endsWith('\n')) text = text.slice(0, -1);

    if (commands.length === 0) {
      if (text.startsWith('shallow ')) {
        shallow.push(text.slice(8));
        continue;
      }
      if (text.startsWith('push-cert')) throw new PktLineError('signed pushes (push-cert) are not supported by git-proxy');
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1).split(' ').filter(Boolean);
        text = text.slice(0, nul);
      }
    }
    const m = COMMAND_RE.exec(text);
    if (!m) throw new PktLineError('malformed ref update command');
    commands.push({ old: m[1]!, new: m[2]!, ref: m[3]! });
  }
}

/**
 * Reads from `stream` until the command section is complete, then PAUSES the stream and returns every byte
 * consumed so far (`head`, which may include the start of the packfile) — the caller forwards `head` and then
 * pipes the rest of the stream. Only the command section is buffered, never the pack.
 */
export function readCommandSection(stream: Readable, maxBytes = 8 * 1024 * 1024): Promise<{ head: Buffer; section: CommandSection }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const tryParse = (): boolean => {
      const head = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      chunks.length = 0;
      chunks.push(head);
      let r: ParseResult;
      try {
        r = parseCommandSection(head);
      } catch (err) {
        finish(() => reject(err));
        return true;
      }
      if (r.done) {
        stream.pause();
        finish(() => resolve({ head, section: r.section }));
        return true;
      }
      return false;
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (tryParse()) return;
      if (total > maxBytes) finish(() => reject(new PktLineError('receive-pack command section too large')));
    };
    const onEnd = () => {
      if (!tryParse()) finish(() => reject(new PktLineError(total === 0 ? 'empty receive-pack request' : 'truncated receive-pack command section')));
    };
    const onError = (err: Error) => finish(() => reject(err));
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * A receive-pack response that rejects every ref, in the shape the client asked for:
 *  - side-band-64k: human message on band 2 ("remote: ..."), report-status on band 1, then flush;
 *  - report-status only: plain report-status;
 *  - neither: null (caller answers with a plain HTTP 403).
 */
export function buildRejection(refs: string[], reason: string, capabilities: string[], message: string): Buffer | null {
  const sideband = capabilities.includes('side-band-64k') || capabilities.includes('side-band');
  const reportStatus = capabilities.includes('report-status') || capabilities.includes('report-status-v2');
  if (!reportStatus && !sideband) return null;
  const cleanReason = reason.replace(/[\r\n]+/g, ' ');
  const report = Buffer.concat([
    encodePkt('unpack ok\n'),
    ...refs.map(r => encodePkt(`ng ${r} ${cleanReason}\n`)),
    FLUSH_PKT,
  ]);
  if (!sideband) return report;
  const maxChunk = (capabilities.includes('side-band-64k') ? MAX_PKT_LEN : 1000) - 5;
  const parts: Buffer[] = [];
  for (const line of message.split('\n').filter(Boolean)) {
    parts.push(encodePkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${line}\n`, 'utf8')])));
  }
  if (reportStatus) {
    for (let i = 0; i < report.length; i += maxChunk) {
      parts.push(encodePkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + maxChunk)])));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}
