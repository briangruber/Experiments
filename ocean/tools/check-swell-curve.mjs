#!/usr/bin/env node
// Does the swell mound's curved spine actually land where the mesh's own
// vertex stage puts the body, and does it fall back to the old straight
// capsule when nothing asks it to curve?
//
//   node tools/check-swell-curve.mjs
//
// Pure algebra, no GPU and no browser (tsl-porting-rules.md #8, step 5: when a
// probe would need one, transcribe the shader function to CPU JS and compare
// numbers instead). Two formulas are transcribed here, independently, from
// their TSL sources:
//
//   meshWorldXZ()  demo/three-main.js's setCraftTransform basis vectors
//                  (f/r/u/b with pitch=roll=modelYaw=0, the case the sea
//                  dragon always runs in) composed with creature.js's
//                  creatureVertex() lateral sine offset.
//   spinePoint()   src/gpu/tsl/water-surface.js's swellLift(), the "spine"
//                  local var - the point the Gaussian is centred on at a
//                  given station.
//
// If the by-hand axis derivation in swellLift's comments is wrong - wrong
// sign on `perp`, wrong direction for `along` - this is where it shows up: as
// a large mismatch between the two, not as "the water looks a bit off" three
// screenshots later.

const TAU = 2 * Math.PI;

// ---- creature.js's creatureVertex(), the lateral offset only --------------
// s: 0 at the nose, 1 at the tail. Mirrors creature.js exactly (ramp bounds,
// TAU, the lot) - deliberately not "close enough", since the whole point of
// this check is bit-for-bit agreement with what the mesh does.
function creatureLateral(s, waves, ampFrac, lengthM, phase) {
  const k = waves * TAU;
  const ph = s * k - phase;
  const ramp = smoothstep(0.06, 0.85, s);
  const amp = ampFrac * lengthM * ramp;
  return Math.sin(ph) * amp;
}
function smoothstep(lo, hi, x) {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

// ---- demo/three-main.js's setCraftTransform, pitch=roll=modelYaw=0 --------
// f = forward (nose), r = local +X world direction, b = -f = local +Z world
// direction (creature.js: "Nose sits at -Z"). Transcribed straight from the
// matrix build, not simplified by hand, so a sign error there would survive
// into this function too rather than being algebra'd away.
function meshBasis(heading) {
  const cy = Math.cos(heading), sy = Math.sin(heading);
  const f = [sy, 0, -cy];
  const r = [cy, 0, sy];
  const b = [-f[0], -f[1], -f[2]];
  return { f, r, b };
}

// World XZ of the point at station s on the mesh (bodyPos + local (lateral, 0,
// localZ) through the basis above). localZ runs -half..+half, nose at -half.
function meshWorldXZ(bodyXZ, heading, s, lengthM, waves, ampFrac, phase) {
  const half = lengthM * 0.5;
  const localZ = -half + s * (2 * half);
  const lateral = creatureLateral(s, waves, ampFrac, lengthM, phase);
  const { r, b } = meshBasis(heading);
  return [
    bodyXZ[0] + localZ * b[0] + lateral * r[0],
    bodyXZ[1] + localZ * b[2] + lateral * r[2],
  ];
}

// ---- water-surface.js's swellLift(), the spine point only -----------------
// uSwellDir = (sin(heading), -cos(heading)) - the same value
// demo/three-main.js writes into the uniform every frame.
function spinePoint(bodyXZ, heading, s, lengthM, waves, ampFrac, phase) {
  const half = lengthM * 0.5;
  const dir = [Math.sin(heading), -Math.cos(heading)];
  const along = half * (1 - 2 * s);   // inverse of s = (half - along) / (2*half)
  const perp = [-dir[1], dir[0]];
  const k = waves * TAU;
  const ph = s * k - phase;
  const ramp = smoothstep(0.06, 0.85, s);
  const lateral = Math.sin(ph) * ampFrac * lengthM * ramp;
  return [
    bodyXZ[0] + dir[0] * along + perp[0] * lateral,
    bodyXZ[1] + dir[1] * along + perp[1] * lateral,
  ];
}

const results = [];
const need = (name, ok, detail) => { results.push({ name, ok, detail }); };

// ---- 1. the mound's spine lands where the mesh actually is ----------------
const HEADINGS = [0, 0.7, -1.3, Math.PI / 2, 3.05];
const STATIONS = [0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.97];
const PHASES = [0, 1.1, -2.4, 5.0];
const WAVES = 1.25, AMP = 0.055, LEN = 22.0;
const BODY = [12.4, -37.9];   // nonzero, so a missed bodyXZ offset would show up

let worst = 0, worstDetail = '';
for (const heading of HEADINGS) {
  for (const s of STATIONS) {
    for (const phase of PHASES) {
      const mesh = meshWorldXZ(BODY, heading, s, LEN, WAVES, AMP, phase);
      const spine = spinePoint(BODY, heading, s, LEN, WAVES, AMP, phase);
      const err = Math.hypot(mesh[0] - spine[0], mesh[1] - spine[1]);
      if (err > worst) { worst = err; worstDetail = `heading=${heading} s=${s} phase=${phase}`; }
    }
  }
}
need('the curved spine matches the mesh\'s own vertex stage', worst < 1e-9,
    `worst mismatch ${worst.toExponential(2)} m at ${worstDetail} ` +
    `across ${HEADINGS.length * STATIONS.length * PHASES.length} combinations`);

// ---- 2. zero sweep is the old straight capsule, exactly --------------------
// The comment in water-surface.js promises this; a caller with a rigid body
// (uSwellSweep left at its 0 default) must get back precisely the pre-curve
// behaviour, not an approximation of it.
let straightWorst = 0;
for (const heading of HEADINGS) {
  for (const s of STATIONS) {
    const dir = [Math.sin(heading), -Math.cos(heading)];
    const half = LEN * 0.5;
    const along = half * (1 - 2 * s);
    const straightLine = [BODY[0] + dir[0] * along, BODY[1] + dir[1] * along];
    const spine = spinePoint(BODY, heading, s, LEN, /* waves */ 1.25, /* ampFrac */ 0, /* phase */ 2.2);
    const err = Math.hypot(straightLine[0] - spine[0], straightLine[1] - spine[1]);
    if (err > straightWorst) straightWorst = err;
  }
}
need('zero sweep falls back to the straight capsule exactly', straightWorst < 1e-12,
    `worst deviation from the straight line ${straightWorst.toExponential(2)} m`);

// ---- 3. the curve actually moves the mound - this is not a no-op ----------
// Sanity in the other direction: at the amidships station with a non-trivial
// sweep, the curved spine must be MEASURABLY off the straight line, or the
// whole feature could have silently failed to wire up (uSwellSweep stuck at
// its 0 default, say) and check 1 would still pass, because 0 mismatch also
// happens when both formulas degenerate to the same straight line.
{
  const heading = 0.4, s = 0.5, phase = 0.0;
  const dir = [Math.sin(heading), -Math.cos(heading)];
  const half = LEN * 0.5;
  const along = half * (1 - 2 * s);
  const straightLine = [BODY[0] + dir[0] * along, BODY[1] + dir[1] * along];
  const spine = spinePoint(BODY, heading, s, LEN, WAVES, AMP, phase);
  const dev = Math.hypot(straightLine[0] - spine[0], straightLine[1] - spine[1]);
  // Amidships (s=0.5), ramp(0.5) is near its plateau (~1), so the deviation
  // should be close to sin(k*0.5 - 0)*AMP*LEN - not a tight bound, just proof
  // of life: metres, not micrometres.
  need('a non-trivial sweep visibly bends the spine', dev > 0.1,
      `${dev.toFixed(3)} m off the straight line amidships (heading 0.4 rad, phase 0)`);
}

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (r.detail) console.log(`        ${r.detail}`);
}
const allOk = results.every((r) => r.ok);
console.log(`\n${allOk ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(allOk ? 0 : 1);
