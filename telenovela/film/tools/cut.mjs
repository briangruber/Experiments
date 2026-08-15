#!/usr/bin/env node
// Cut the shots together into the scene.
//
//   node tools/cut.mjs                 # dist/s01-testamento.mp4
//   node tools/cut.mjs --no-bed        # picture and diegetic sound only
//   node tools/cut.mjs --print         # show the ffmpeg graph and stop
//
// The edit is deliberately plain — trim each shot to its marks, hard cut
// between them, lay one continuous music bed underneath. No dissolves, no
// stingers, no per-shot audio treatment. A shot/reverse exchange is cut hard;
// dissolving it would read as a time jump, which is not what happens here.
//
// Two decisions in here are the whole point of the experiment:
//
// 1. The picture cuts hard and so does the diegetic audio. Room tone differs
//    slightly between two independently generated shots, so that audio cut is
//    a real seam. It is not fixed by fading — a dip at the cut is more
//    audible than the seam — it is *masked*, by the one element that runs
//    straight through the edit untouched.
//
// 2. That element is the bed, and it is ducked against the dialogue rather
//    than set to a fixed low level. A fixed level either buries the voices in
//    the loud moments or vanishes in the quiet ones; a sidechain keeps it
//    present under the silences and out of the way under the lines, which is
//    what makes it read as scoring rather than as backing track.

import { mkdir, access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SCENE from '../scenes/s01-testamento/scene.js';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'shots');
const DIST = join(ROOT, 'dist');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const args = process.argv.slice(2);
const NO_BED = args.includes('--no-bed');
const PRINT = args.includes('--print');
const exists = (p) => access(p).then(() => true, () => false);

// Marks. A shot is generated longer than it plays so the edit has handles;
// this is where the handles get spent. `in`/`out` are seconds into the
// generated clip.
const marks = SCENE.shots.map((s) => ({
  ...s,
  in: s.cut?.in ?? 0,
  out: s.cut?.out ?? Number(s.duration),
}));

for (const m of marks) {
  const p = join(SHOTS, `${m.id}.mp4`);
  if (!(await exists(p))) {
    console.error(`missing shot: shots/${m.id}.mp4 — run tools/shoot.mjs first`);
    process.exit(1);
  }
  m.path = p;
  m.length = m.out - m.in;
}

const total = marks.reduce((n, m) => n + m.length, 0);
const bed = join(DIST, 'bed.mp3');
const useBed = !NO_BED && (await exists(bed));

// ---------------------------------------------------------------------------
// The filter graph
// ---------------------------------------------------------------------------

const parts = [];
marks.forEach((m, i) => {
  // setpts/asetpts rebase each trimmed segment to zero; without them concat
  // honours the original timestamps and the second shot lands six seconds
  // into a black frame.
  parts.push(`[${i}:v]trim=${m.in}:${m.out},setpts=PTS-STARTPTS,fps=24,scale=1280:720,setsar=1[v${i}]`);
  parts.push(`[${i}:a]atrim=${m.in}:${m.out},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
});

const chain = marks.map((_, i) => `[v${i}][a${i}]`).join('');
parts.push(`${chain}concat=n=${marks.length}:v=1:a=1[vcat][acat]`);

// A gentle fade off the top and tail of the picture. Everything between the
// two shots is a straight cut.
parts.push(`[vcat]fade=t=in:st=0:d=0.35,fade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5[vout]`);

let AOUT = '[acat]';
if (useBed) {
  // The diegetic track is split three ways: one copy into the mix, one to key
  // the compressor, and the split is what lets the dialogue duck its own bed.
  parts.push(`[acat]asplit=2[adry][akey]`);
  parts.push(
    `[${marks.length}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,` +
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
    // Low-shelved out of the way of the voices before it is even ducked.
    `highpass=f=60,volume=0.30,` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6[bedraw]`,
  );
  parts.push(
    `[bedraw][akey]sidechaincompress=threshold=0.03:ratio=8:attack=25:release=450:makeup=1[bedduck]`,
  );
  parts.push(`[adry][bedduck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
  AOUT = '[aout]';
}

const graph = parts.join(';');
const out = join(DIST, `${SCENE.id}.mp4`);

const cmd = [
  '-y',
  ...marks.flatMap((m) => ['-i', m.path]),
  ...(useBed ? ['-i', bed] : []),
  '-filter_complex', graph,
  '-map', '[vout]', '-map', AOUT,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
  out,
];

if (PRINT) {
  console.log(graph.split(';').join(';\n'));
  process.exit(0);
}

await mkdir(DIST, { recursive: true });
console.log(`\ncutting ${SCENE.title}\n`);
for (const m of marks) {
  console.log(`  ${m.slate.padEnd(24)} ${m.in.toFixed(2)}–${m.out.toFixed(2)}  (${m.length.toFixed(2)}s)`);
}
console.log(`  ${'—'.repeat(24)} ${total.toFixed(2)}s total`);
console.log(`  bed: ${useBed ? 'dist/bed.mp3, ducked under dialogue' : 'none'}\n`);

await run(FFMPEG, cmd, { maxBuffer: 1 << 26 });
console.log(`  ${((await stat(out)).size / 1e6).toFixed(1)} MB  ->  dist/${SCENE.id}.mp4`);
