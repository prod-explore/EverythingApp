import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import { buildRejection, encodePkt, FLUSH_PKT, parseCommandSection, PktLineError, readCommandSection } from '../pktline.js';
import { decodePkts, receivePackBody, sha, ZERO } from './helpers.js';

describe('pkt-line command section parser', () => {
  it('parses a single ref with capabilities', () => {
    const buf = receivePackBody([{ old: sha('a'), new: sha('b'), ref: 'refs/heads/main' }], 'report-status side-band-64k quiet');
    const r = parseCommandSection(buf);
    assert.equal(r.done, true);
    if (!r.done) return;
    assert.deepEqual(r.section.commands, [{ old: sha('a'), new: sha('b'), ref: 'refs/heads/main' }]);
    assert.deepEqual(r.section.capabilities, ['report-status', 'side-band-64k', 'quiet']);
    assert.equal(r.end, buf.length);
  });

  it('parses multiple refs (caps only on the first) and stops at the flush before the pack', () => {
    const pack = Buffer.from('PACK\x00\x00\x00\x02rest-of-pack');
    const buf = receivePackBody(
      [
        { old: ZERO, new: sha('1'), ref: 'refs/heads/feature' },
        { old: sha('2'), new: ZERO, ref: 'refs/heads/old' },
        { old: sha('3'), new: sha('4'), ref: 'refs/tags/v1' },
      ],
      'report-status-v2 atomic',
      pack,
    );
    const r = parseCommandSection(buf);
    assert.ok(r.done);
    if (!r.done) return;
    assert.equal(r.section.commands.length, 3);
    assert.equal(r.section.commands[1]!.new, ZERO);
    assert.equal(r.section.commands[2]!.ref, 'refs/tags/v1');
    assert.deepEqual(r.section.capabilities, ['report-status-v2', 'atomic']);
    assert.equal(buf.subarray(r.end).toString('latin1'), pack.toString('latin1'));
  });

  it('flush-only body (auth probe) has zero commands', () => {
    const r = parseCommandSection(FLUSH_PKT);
    assert.ok(r.done && r.section.commands.length === 0);
  });

  it('accepts shallow lines and sha256 object ids', () => {
    const s256a = 'a'.repeat(64);
    const s256b = 'b'.repeat(64);
    const buf = Buffer.concat([encodePkt(`shallow ${sha('c')}\n`), encodePkt(`${s256a} ${s256b} refs/heads/x\0object-format=sha256\n`), FLUSH_PKT]);
    const r = parseCommandSection(buf);
    assert.ok(r.done);
    if (!r.done) return;
    assert.deepEqual(r.section.shallow, [sha('c')]);
    assert.equal(r.section.commands[0]!.old, s256a);
    assert.deepEqual(r.section.capabilities, ['object-format=sha256']);
  });

  it('reports incomplete input and rejects garbage', () => {
    const full = receivePackBody([{ old: sha('a'), new: sha('b'), ref: 'refs/heads/main' }]);
    assert.deepEqual(parseCommandSection(full.subarray(0, 10)), { done: false });
    assert.deepEqual(parseCommandSection(full.subarray(0, full.length - 2)), { done: false });
    assert.throws(() => parseCommandSection(Buffer.from('zzzzhello')), PktLineError);
    assert.throws(() => parseCommandSection(Buffer.concat([encodePkt('not a command\n'), FLUSH_PKT])), PktLineError);
    assert.throws(() => parseCommandSection(Buffer.concat([encodePkt('push-cert\0report-status\n'), FLUSH_PKT])), /push-cert/);
  });

  it('readCommandSection assembles byte-sized chunks and returns the head incl. pack bytes', async () => {
    const pack = Buffer.from('PACKDATA');
    const buf = receivePackBody(
      [
        { old: sha('a'), new: sha('b'), ref: 'refs/heads/main' },
        { old: ZERO, new: sha('c'), ref: 'refs/heads/new' },
      ],
      undefined,
      pack,
    );
    const s = new PassThrough();
    const p = readCommandSection(s);
    for (let i = 0; i < buf.length; i += 7) s.write(buf.subarray(i, i + 7));
    const { head, section } = await p;
    assert.equal(section.commands.length, 2);
    assert.ok(buf.subarray(0, head.length).equals(head));
    // The rest is still readable from the paused stream.
    s.end();
    const rest: Buffer[] = [];
    for await (const c of s) rest.push(c as Buffer);
    assert.ok(Buffer.concat([head, ...rest]).equals(buf));
  });

  it('readCommandSection works on a gzip-compressed request body', async () => {
    const buf = receivePackBody([{ old: sha('d'), new: sha('e'), ref: 'refs/heads/dev' }], 'report-status', Buffer.from('PACK'));
    const src = new PassThrough();
    const gunzip = src.pipe(createGunzip());
    const p = readCommandSection(gunzip);
    src.end(gzipSync(buf));
    const { section } = await p;
    assert.deepEqual(section.commands, [{ old: sha('d'), new: sha('e'), ref: 'refs/heads/dev' }]);
  });

  it('readCommandSection rejects a truncated or empty body', async () => {
    const s1 = new PassThrough();
    const p1 = readCommandSection(s1);
    s1.end(encodePkt(`${sha('a')} ${sha('b')} refs/heads/main\n`));
    await assert.rejects(p1, /truncated/);
    const s2 = new PassThrough();
    const p2 = readCommandSection(s2);
    s2.end();
    await assert.rejects(p2, /empty/);
  });
});

describe('receive-pack rejection', () => {
  it('side-band-64k: message on band 2, report-status with ng lines on band 1', () => {
    const out = buildRejection(['refs/heads/main', 'refs/heads/x'], 'rejected by user', ['report-status', 'side-band-64k'], 'git-proxy: push rejected.');
    assert.ok(out);
    const pkts = decodePkts(out!);
    assert.equal(pkts.at(-1), null);
    const band2 = pkts.filter(p => p && p[0] === 2).map(p => p!.subarray(1).toString()).join('');
    assert.match(band2, /push rejected/);
    const band1 = Buffer.concat(pkts.filter(p => p && p[0] === 1).map(p => p!.subarray(1)));
    const inner = decodePkts(band1).map(p => (p ? p.toString() : null));
    assert.deepEqual(inner, ['unpack ok\n', 'ng refs/heads/main rejected by user\n', 'ng refs/heads/x rejected by user\n', null]);
  });

  it('report-status without side-band: plain report', () => {
    const out = buildRejection(['refs/heads/main'], 'rejected by user', ['report-status'], 'msg');
    assert.deepEqual(decodePkts(out!).map(p => (p ? p.toString() : null)), ['unpack ok\n', 'ng refs/heads/main rejected by user\n', null]);
  });

  it('no report-status/side-band: null (caller sends 403)', () => {
    assert.equal(buildRejection(['refs/heads/main'], 'x', ['quiet'], 'msg'), null);
  });
});
