#!/usr/bin/env node
// Verify the backdrop assets without being able to play them.
//
//   node tools/check-scene.mjs
//
// Headless Chromium ships no H.264 decoder, so the browser check cannot tell a
// good scene.mp4 from a truncated one — it falls back to the still and reports
// success either way. That is precisely the silent-fallback failure this
// project keeps rediscovering, so the video is checked as a file instead:
// walk the ISO-BMFF boxes and read the dimensions and duration out of the
// headers. It does not prove the picture is good; it proves the asset is real,
// the right shape, and the right length.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(name);
};
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// --- a very small ISO base media file parser --------------------------------

function* boxes(buf, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size < 8 || off + size > end) return;
    yield { type, start: off, size, body: off + 8 };
    off += size;
  }
}
function find(buf, path, start = 0, end = buf.length) {
  const [head, ...rest] = path;
  for (const b of boxes(buf, start, end)) {
    if (b.type !== head) continue;
    if (!rest.length) return b;
    const inner = find(buf, rest, b.body, b.start + b.size);
    if (inner) return inner;
  }
  return null;
}

const MP4 = join(ROOT, 'assets/scene.mp4');
if (!(await exists(MP4))) {
  console.error('no assets/scene.mp4 — run: node tools/scene.mjs still && node tools/scene.mjs loop');
  process.exit(1);
}
const buf = await readFile(MP4);

check('file is an ISO media file', buf.toString('latin1', 4, 8) === 'ftyp',
  buf.toString('latin1', 8, 20).replace(/[^\x20-\x7e]/g, '.'));
check('declares H.264 (avc1)', buf.toString('latin1', 8, 32).includes('avc1'));

const mdat = find(buf, ['mdat']);
check('has media data', !!mdat, mdat ? `${(mdat.size / 1024 / 1024).toFixed(2)} MB` : 'missing');
// A truncated download is the common failure and it looks exactly like a valid
// header followed by nothing.
check('media data is complete', !!mdat && mdat.start + mdat.size <= buf.length,
  mdat ? `ends at ${mdat.start + mdat.size} of ${buf.length}` : '');

const mvhd = find(buf, ['moov', 'mvhd']);
let seconds = 0;
if (mvhd) {
  const v = buf[mvhd.body];
  const o = mvhd.body + 4 + (v === 1 ? 16 : 8);
  const timescale = buf.readUInt32BE(o);
  const duration = v === 1 ? Number(buf.readBigUInt64BE(o + 4)) : buf.readUInt32BE(o + 4);
  seconds = duration / timescale;
}
check('duration is a usable loop length', seconds > 2 && seconds < 20, `${seconds.toFixed(2)}s`);

const tkhd = find(buf, ['moov', 'trak', 'tkhd']);
let w = 0, h = 0;
if (tkhd) {
  const v = buf[tkhd.body];
  const base = tkhd.start + (v === 1 ? 32 : 20) + 64;
  w = buf.readUInt32BE(base) / 65536;
  h = buf.readUInt32BE(base + 4) / 65536;
}
const ratio = h ? w / h : 0;
check('track has dimensions', w > 0 && h > 0, `${w}x${h}`);
// The room is 16:9 and the backdrop is stretched to fill it, so anything else
// arrives visibly squashed.
check('is 16:9', Math.abs(ratio - 16 / 9) < 0.02, `ratio ${ratio.toFixed(3)}`);

const STILL = join(ROOT, 'assets/scene.jpg');
check('web-sized still exists as a fallback', await exists(STILL),
  (await exists(STILL)) ? `${((await stat(STILL)).size / 1024).toFixed(0)} KB` : 'missing');

console.log('');
if (fails.length) { console.error(`FAILED: ${fails.join(', ')}`); process.exit(1); }
console.log('scene assets ok (playback itself is unverifiable here — headless Chromium has no H.264)');
