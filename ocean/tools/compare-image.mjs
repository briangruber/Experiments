#!/usr/bin/env node
// Diff two rendered HDR images - the WebGL2 reference against a TSL port.
//
//   node tools/compare-image.mjs test/golden/sky.json test/out/sky-tsl.json
//
// A rendered image needs a looser bar than a wave field, and for a reason worth
// stating rather than fudging.
//
// The wave simulation is arithmetic on data: the same operations in the same
// order, so agreement to 1e-5 is achievable and anything worse is a defect. A
// raymarched sky is not. It samples a noise field along a ray whose start is
// dithered per pixel, and a difference of one ulp in the hash moves a sample
// across a density gradient. That shifts a cloud edge by a fraction of a step and
// changes that pixel by percent, while the sky it belongs to is unchanged.
//
// So this checks two different things:
//
//   the distribution - mean, rms, peak - which a real defect moves and which
//   sampling noise does not. A dropped scattering term, a wrong phase function,
//   a mis-mapped LUT direction all change the energy in the image.
//
//   the bulk of pixels - the 99th percentile of relative error - which catches a
//   region being wrong while tolerating edges that landed a step apart.
//
// A worst-pixel bound is deliberately NOT a failure condition. One pixel on a
// cloud edge can differ by a lot in a correct port, and failing on it would
// teach us to raise the threshold until nothing fails.

import { readFile, writeFile } from 'node:fs/promises';

const [refPath, candPath, diffOut] = process.argv.slice(2);
if (!refPath || !candPath) {
  console.error('usage: compare-image.mjs <reference.json> <candidate.json> [diff.pgm]');
  process.exit(2);
}

const STAT_TOL = 0.01;      // 1% on mean / rms / peak
const PIXEL_TOL = 0.02;     // 2% relative, per pixel
const PERCENTILE = 0.99;    // ...for this share of them

const ref = JSON.parse(await readFile(refPath, 'utf8'));
const cand = JSON.parse(await readFile(candPath, 'utf8'));

const problems = [];
for (const k of ['W', 'H', 'preset']) {
  if (ref.config[k] !== cand.config[k]) {
    problems.push(`config mismatch: ${k} ${ref.config[k]} vs ${cand.config[k]} — comparing different renders`);
  }
}
if (JSON.stringify(ref.config.rig) !== JSON.stringify(cand.config.rig)) {
  problems.push('camera rig differs — the images are of different views');
}

// Scale by the reference's own rms: a pixel of near-zero radiance has no
// meaningful relative error, and dividing by it manufactures enormous ones.
const scale = Math.max(ref.stats.rms, 1e-6);

console.log('distribution');
for (const k of ['mean', 'rms', 'min', 'max']) {
  const a = ref.stats[k], b = cand.stats[k];
  const rel = Math.abs(a - b) / scale;
  const ok = rel < STAT_TOL;
  console.log(`  ${k.padEnd(5)} ${a.toFixed(6)} vs ${b.toFixed(6)}   rel ${rel.toExponential(2)}  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) problems.push(`${k} differs by ${(rel * 100).toFixed(2)}% of rms (limit ${STAT_TOL * 100}%)`);
}

const A = ref.pixels, B = cand.pixels;
if (A.length !== B.length) {
  problems.push(`pixel count differs: ${A.length} vs ${B.length}`);
} else {
  const errs = [];
  let worst = 0, worstAt = -1;
  for (let i = 0; i < A.length; i += 4) {
    // Luma, not per channel: a channel near zero gives a meaningless ratio.
    const la = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
    const lb = 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
    const e = Math.abs(la - lb) / scale;
    errs.push(e);
    if (e > worst) { worst = e; worstAt = i / 4; }
  }
  errs.sort((a, b) => a - b);
  const p99 = errs[Math.floor(errs.length * PERCENTILE)];
  const beyond = errs.filter((e) => e > PIXEL_TOL).length;
  const ok = p99 < PIXEL_TOL;
  console.log('\npixels');
  console.log(`  ${(PERCENTILE * 100).toFixed(0)}th percentile   ${p99.toExponential(2)}  ${ok ? 'ok' : 'FAIL'} (limit ${PIXEL_TOL})`);
  console.log(`  beyond ${PIXEL_TOL}       ${beyond} / ${errs.length} (${(100 * beyond / errs.length).toFixed(2)}%)`);
  console.log(`  worst            ${worst.toExponential(2)} at pixel ${worstAt}   (not a failure condition — see the header)`);
  if (!ok) {
    problems.push(`${(100 * beyond / errs.length).toFixed(1)}% of pixels beyond ${PIXEL_TOL} — that is a region, not sampling noise`);
  }

  if (diffOut) {
    const { W, H } = ref.config;
    const head = `P2\n${W} ${H}\n255\n`;
    const body = [];
    for (let y = H - 1; y >= 0; y--) {
      const row = [];
      for (let x = 0; x < W; x++) {
        row.push(Math.min(255, Math.round(errs.length ? (Math.abs(
          (0.2126 * A[(y * W + x) * 4] + 0.7152 * A[(y * W + x) * 4 + 1] + 0.0722 * A[(y * W + x) * 4 + 2]) -
          (0.2126 * B[(y * W + x) * 4] + 0.7152 * B[(y * W + x) * 4 + 1] + 0.0722 * B[(y * W + x) * 4 + 2]),
        ) / scale) * 255 / PIXEL_TOL : 0)));
      }
      body.push(row.join(' '));
    }
    await writeFile(diffOut, head + body.join('\n') + '\n');
    console.log(`\ndiff image -> ${diffOut} (white = at the ${PIXEL_TOL} limit)`);
  }
}

console.log('');
if (problems.length) {
  console.error('MISMATCH');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`MATCH — distribution within ${STAT_TOL * 100}%, ${(PERCENTILE * 100).toFixed(0)}% of pixels within ${PIXEL_TOL * 100}%`);
