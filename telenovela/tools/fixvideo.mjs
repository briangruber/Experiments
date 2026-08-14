#!/usr/bin/env node
// Repair a recording that opens as 00:00.
//
//   node tools/fixvideo.mjs ~/Downloads/corazon-de-gallina-trailer.mp4
//
// MediaRecorder streams, so it never writes a duration into the file header.
// Browsers cope by scanning the whole thing; QuickTime does not, and shows a
// clip that is really there as zero seconds long. This adds up the sample
// durations in the fragments and writes the totals into the headers. It is the
// same function the page runs after recording, so this is only needed for files
// made before that existed.

import { readFile, writeFile } from 'node:fs/promises';
import { fixMp4Duration } from '../src/record.js';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: node tools/fixvideo.mjs <in.mp4> [out.mp4]');
  process.exit(1);
}
const out = output || input.replace(/\.mp4$/i, '') + '-fixed.mp4';
const raw = new Uint8Array(await readFile(input));
const fixed = new Uint8Array(fixMp4Duration(raw.slice().buffer));

// Report what the headers say now, so a no-op is obvious rather than silent.
const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const readDuration = (b) => {
  let o = 0;
  while (o + 8 <= b.length) {
    const size = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (size < 8) break;
    if (type === 'moov') {
      let p = o + 8;
      while (p + 8 <= o + size) {
        const s2 = u32(b, p);
        const t2 = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        if (s2 < 8) break;
        if (t2 === 'mvhd') {
          const v = b[p + 8];
          const ts = u32(b, p + 8 + (v === 1 ? 20 : 12));
          const d = v === 1 ? u32(b, p + 8 + 24) * 4294967296 + u32(b, p + 8 + 28) : u32(b, p + 8 + 16);
          return ts ? d / ts : 0;
        }
        p += s2;
      }
    }
    o += size;
  }
  return null;
};

const before = readDuration(raw);
const after = readDuration(fixed);
if (before === null) {
  console.error(`${input}: not an MP4 this script understands — left alone`);
  process.exit(1);
}
await writeFile(out, fixed);
console.log(`${out}\n  duration header: ${before?.toFixed(2)}s -> ${after?.toFixed(2)}s`);
if (!after) console.error('  (still zero: nothing to add up — the file may have no fragments)');
