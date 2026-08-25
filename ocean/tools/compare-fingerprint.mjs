#!/usr/bin/env node
// Diff two ocean fingerprints - the WebGL2 reference against a candidate port.
//
//   node tools/compare-fingerprint.mjs test/golden/ocean-64.json test/out/wgsl-64.json
//
// Why not a bitwise match: the two are different compilers emitting different
// instruction selection for the same maths. Metal will contract a*b+c into an
// fma where the GLSL path did not, sin() is a different polynomial, and the FFT
// sums 256 terms in an order the two need not agree on. Demanding equality would
// fail on a correct port and teach us to loosen the bar until it passed, which is
// worse than having no bar.
//
// What IS defensible: f32 has ~1.2e-7 of relative precision, and a 256-point FFT
// accumulates error like sqrt(N), so ~2e-6 relative is the floor. An order of
// magnitude of headroom over that catches every real defect - a dropped term, a
// sign, a wrong index all move things by percent, not by parts per million -
// while tolerating legitimate instruction-selection differences.

import { readFile } from 'node:fs/promises';

const [refPath, candPath] = process.argv.slice(2);
if (!refPath || !candPath) {
  console.error('usage: compare-fingerprint.mjs <reference.json> <candidate.json>');
  process.exit(2);
}

const STAT_TOL = 1e-4;      // relative, on mean / rms / min / max
const SAMPLE_TOL = 1e-3;    // relative, per texel
const SAMPLE_FAIL_FRACTION = 0.005;   // a few outliers are noise; a pattern is a bug

const ref = JSON.parse(await readFile(refPath, 'utf8'));
const cand = JSON.parse(await readFile(candPath, 'utf8'));

const rel = (a, b, scale) => Math.abs(a - b) / Math.max(Math.abs(scale), 1e-6);

const problems = [];
const lines = [];

for (const k of ['N', 'steps', 'dt', 'preset', 'seed', 'cascades']) {
  if (ref.config[k] !== cand.config[k]) {
    problems.push(`config mismatch: ${k} ${ref.config[k]} vs ${cand.config[k]} — comparing different runs`);
  }
}

const CH = ['x', 'y', 'z', 'jacobian'];
for (let c = 0; c < Math.min(ref.cascades.length, cand.cascades.length); c++) {
  const R = ref.cascades[c], C = cand.cascades[c];
  lines.push(`\ncascade ${c}  (patch ${R.patch} m)`);

  for (let k = 0; k < 4; k++) {
    const r = R.stats[k], q = C.stats[k];
    // Scale by rms, not by the value itself: a mean near zero makes relative
    // error meaningless, and every one of these channels is zero-mean by
    // construction.
    const scale = Math.max(r.rms, 1e-6);
    const d = {
      mean: rel(r.mean, q.mean, scale), rms: rel(r.rms, q.rms, scale),
      min: rel(r.min, q.min, scale), max: rel(r.max, q.max, scale),
    };
    const worst = Math.max(d.mean, d.rms, d.min, d.max);
    const ok = worst < STAT_TOL;
    lines.push(`  ${CH[k].padEnd(9)} rms ${r.rms.toFixed(6)} vs ${q.rms.toFixed(6)}   worst rel ${worst.toExponential(2)}  ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) problems.push(`cascade ${c} channel ${CH[k]}: statistics differ by ${worst.toExponential(2)} (limit ${STAT_TOL})`);
  }

  // Per-texel: the check that catches a localised geometry error, which the
  // statistics above would happily average away.
  let bad = 0, worstSample = 0, worstAt = -1;
  const n = Math.min(R.samples.length, C.samples.length);
  const scale = Math.max(R.stats[1].rms, 1e-6);
  for (let i = 0; i < n; i++) {
    const e = rel(R.samples[i], C.samples[i], scale);
    if (e > worstSample) { worstSample = e; worstAt = i; }
    if (e > SAMPLE_TOL) bad++;
  }
  const frac = bad / n;
  const ok = frac <= SAMPLE_FAIL_FRACTION;
  lines.push(`  samples   ${bad}/${n} beyond ${SAMPLE_TOL} (${(frac * 100).toFixed(2)}%), worst ${worstSample.toExponential(2)} at index ${worstAt}  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) {
    problems.push(`cascade ${c}: ${bad}/${n} texels differ beyond ${SAMPLE_TOL} — that is a pattern, not rounding`);
  }
}

console.log(lines.join('\n'));
console.log('');
if (problems.length) {
  console.error('MISMATCH');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`MATCH — within ${STAT_TOL} on statistics and ${SAMPLE_TOL} per texel`);
