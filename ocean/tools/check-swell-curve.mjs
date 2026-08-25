#!/usr/bin/env node
// Does the swell mound's animated spine/heave actually match the mesh's own
// vertex stage, and does occupancy displace the sea as a body of that shape
// rather than as one Gaussian blob?
//
//   node tools/check-swell-curve.mjs
//
// Pure algebra, no GPU and no browser (tsl-porting-rules.md #8, step 5: when a
// probe would need one, transcribe the shader function to CPU JS and compare
// numbers instead). Spine formulas live in src/body-displace.js and are
// transcribed into water-surface.js's swellLift(); these two must agree:
//
//   meshWorldXZ()  demo/three-main.js's setCraftTransform basis vectors
//                  (f/r/u/b with pitch=roll=modelYaw=0, the case the sea
//                  dragon always runs in) composed with creature.js's
//                  creatureVertex() lateral and vertical sine offsets.
//   spinePoint()   src/body-displace.js, the XZ of each occupancy station.
//
// Occupancy cases (section 7) are the contract the Gaussian failed: a
// pitched landing depresses at the wet tip, not amidships; beside the
// body is empty; a deeper body opens a deeper hollow; airborne stations
// release the surface.
//
// Section 5 checks swellContactSign(), the driver-side scale that turns
// occupancy into a hollow when the body falls in from the sky.
// Section 6 checks waterContactXZ() / throwSplash(): a pitched landing
// stamps the splash cavity at the hitting station, not amidships.

import { SeaDragon, swellContactSign, waterContactXZ } from '../demo/seadragon.js';
import {
  BODY_STATIONS, SWELL_SITES, spinePoint, spineStation, bodyOccupancy, bodyDisplace,
  sitesOccupancy,
} from '../src/body-displace.js';
import { placeBreachEmitters } from '../src/breach-emitters.js';
import {
  CutRippleField, cutRippleHeight, rippleSpeed, rippleLambda, ripplePush, rippleForce,
  outwardDir, bowHeight, bowFootprint, swellProximity, RIPPLE_LAMBDA, RIPPLE_LAMBDA_MIN, RIPPLE_ATTACK,
} from '../src/cut-ripples.js';

const TAU = 2 * Math.PI;

function aroundRing( field, cx, cz, r, n = 16 ) {

  let max = - 1e9, min = 1e9, ang = 0;
  if ( ! ( r > 0.05 ) ) return { max: 0, min: 0, ang: 0 };
  for ( let i = 0; i < n; i ++ ) {

    const a = i / n * TAU;
    const h = cutRippleHeight( cx + Math.cos( a ) * r, cz + Math.sin( a ) * r, field );
    if ( h > max ) { max = h; ang = a; }
    if ( h < min ) min = h;

  }
  return { max, min, ang };

}

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
function creatureVertical(s, waves, ampFrac, lengthM, phase, both) {
  const k = waves * TAU;
  const ph = s * k - phase + (both ? Math.PI * 0.5 : 0);
  const ramp = smoothstep(0.06, 0.85, s);
  return Math.sin(ph) * ampFrac * lengthM * ramp;
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

// ---- 2. vertical station motion matches Up/down and Both -------------------
let heaveWorst = 0, heaveDetail = '';
for (const both of [false, true]) {
  const liftPhase = both ? Math.PI * 0.5 : 0;
  for (const s of STATIONS) {
    for (const phase of PHASES) {
      const meshY = creatureVertical(s, WAVES, AMP, LEN, phase, both);
      const st = spineStation(s, {
        x: 0, y: 0, z: 0, len: LEN, rad: 7.5,
        dirx: 0, dirz: -1, waves: WAVES, sweep: 0, lift: AMP,
        liftPhase, phase, pitch: 0,
      });
      const err = Math.abs(meshY - (st.y - 0));
      if (err > heaveWorst) {
        heaveWorst = err;
        heaveDetail = `mode=${both ? 'Both' : 'Up/down'} s=${s} phase=${phase}`;
      }
    }
  }
}
need('the station heave matches the mesh\'s vertical vertex wave', heaveWorst < 1e-9,
    `worst mismatch ${heaveWorst.toExponential(2)} m at ${heaveDetail}`);

{
  // Occupancy is a unit sheath, not metres-of-back. A piercing amidships
  // station is ~1; the heave itself is already checked in section 2.
  const base = {
    x: 0, y: -2, z: 0, len: LEN, rad: 7.5, sea: 0,
    dirx: 0, dirz: -1, waves: WAVES, sweep: 0, lift: AMP,
    liftPhase: 0, pitch: 0, sign: 1,
  };
  const h = bodyOccupancy( 0, 0, { ...base, phase: 0 } );
  need( 'a piercing spine sample is a unit bump, not a wall of back-height',
    h > 0.7 && h <= 1.0001,
    `amidships occupancy ${ h.toFixed( 3 ) }` );
}

// ---- 3. zero sweep/lift is the old rigid capsule, exactly ------------------
// The comment in body-displace.js promises this; a caller with a rigid body
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
{
  const st = spineStation(0.5, {
    x: 0, y: 4, z: 0, len: LEN, rad: 7.5,
    dirx: 0, dirz: -1, waves: WAVES, sweep: 0, lift: 0,
    liftPhase: 0, phase: 1.1, pitch: 0,
  });
  need('zero lift leaves station Y at the origin exactly', Math.abs(st.y - 4) < 1e-12,
      `zero-lift amidships Y ${st.y}`);
}

// ---- 4. the curve actually moves the mound - this is not a no-op ----------
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

// ---- 5. landing from the sky inverts the mound, swimming does not ---------
// bodyDisplace multiplies occupancy by uSwellAmp as-is; the SIGN is a
// driver-side scale (swellContactSign), not a second formula. These are the
// cases the water used to get wrong: a fall kept the swim bulge instead of
// pressing a hollow.
{
  const swim = swellContactSign({ jumping: false, jumpPhase: null, jumpVy: -3 });
  const rise = swellContactSign({ jumping: true, jumpPhase: 'rise', jumpVy: 8 });
  const airUp = swellContactSign({ jumping: true, jumpPhase: 'air', jumpVy: 6 });
  const airDown = swellContactSign({ jumping: true, jumpPhase: 'air', jumpVy: -12 });
  const waterDown = swellContactSign({ jumping: true, jumpPhase: 'water', jumpVy: -8 });
  const waterUp = swellContactSign({ jumping: true, jumpPhase: 'water', jumpVy: 1.5 });
  const airborneOnly = swellContactSign({ jumping: true, jumpPhase: null, jumpVy: 0, jumpAirborne: true });
  need('a swimming dive still raises a bulge', swim === 1, `sign ${swim}`);
  need('coming up from underneath still raises a bulge', rise === 1, `sign ${rise}`);
  need('an airborne climb (still exiting) still raises a bulge', airUp === 1, `sign ${airUp}`);
  need('falling from the sky presses a hollow', airDown === -1, `sign ${airDown}`);
  need('a landing still sounding keeps the hollow', waterDown === -1, `sign ${waterDown}`);
  need('floating back after a landing returns toward a bulge', waterUp > 0, `sign ${waterUp}`);
  need('jumpAirborne alone does not invert the mound', airborneOnly === 1, `sign ${airborneOnly}`);
}

// ---- 6. a landing hollow is centred on the hitting station, not mid-body --
// The origin is amidships. A nose-down 60 m body hits with the nose; stamping
// uSwellPos / splashX/Z at pos[] put the dent under empty belly. The contact
// helper is what three-main.js and throwSplash now share for the splash
// field; occupancy (section 7) makes the continuous hollow automatic.
{
  const L = 60;
  const origin = [ 12, - 4, - 37 ];
  const level = waterContactXZ( { pos: origin, heading: 0, pitch: 0 }, { sdLength: L } );
  need( 'a level belly-flop stays at the origin',
    Math.hypot( level.x - origin[ 0 ], level.z - origin[ 2 ] ) < 1e-9,
    `contact (${ level.x.toFixed( 2 ) }, ${ level.z.toFixed( 2 ) })` );

  const noseDown = waterContactXZ( { pos: origin, heading: 0, pitch: - 0.55 }, { sdLength: L } );
  const nose = [ origin[ 0 ], origin[ 2 ] - L * 0.5 ];
  const dNose = Math.hypot( noseDown.x - nose[ 0 ], noseDown.z - nose[ 1 ] );
  const dOrigin = Math.hypot( noseDown.x - origin[ 0 ], noseDown.z - origin[ 2 ] );
  need( 'a nose-down landing depresses nearer the nose than the origin',
    dNose < dOrigin && dOrigin > L * 0.2,
    `contact (${ noseDown.x.toFixed( 1 ) }, ${ noseDown.z.toFixed( 1 ) }) ` +
    `nose (${ nose[ 0 ].toFixed( 1 ) }, ${ nose[ 1 ].toFixed( 1 ) }) ` +
    `dNose ${ dNose.toFixed( 2 )} dOrigin ${ dOrigin.toFixed( 2 )}` );

  const tailDown = waterContactXZ( { pos: origin, heading: 0, pitch: 0.55 }, { sdLength: L } );
  const tail = [ origin[ 0 ], origin[ 2 ] + L * 0.5 ];
  need( 'a tail-down landing depresses nearer the tail than the origin',
    Math.hypot( tailDown.x - tail[ 0 ], tailDown.z - tail[ 1 ] ) <
      Math.hypot( tailDown.x - origin[ 0 ], tailDown.z - origin[ 2 ] ),
    `contact (${ tailDown.x.toFixed( 1 ) }, ${ tailDown.z.toFixed( 1 ) })` );

  // heading π/2 looks down +X; nose (local −Z) is at origin + (+X)*half.
  const yawed = waterContactXZ( { pos: origin, heading: Math.PI / 2, pitch: - 0.4 }, { sdLength: L } );
  const yawedNose = [ origin[ 0 ] + L * 0.5, origin[ 2 ] ];
  need( 'contact follows heading, not a fixed world axis',
    Math.hypot( yawed.x - yawedNose[ 0 ], yawed.z - yawedNose[ 1 ] ) < 1e-6,
    `contact (${ yawed.x.toFixed( 2 ) }, ${ yawed.z.toFixed( 2 ) }) ` +
    `expected (${ yawedNose[ 0 ].toFixed( 2 ) }, ${ yawedNose[ 1 ].toFixed( 2 ) })` );

  const fromProfile = waterContactXZ(
    { pos: origin, heading: 0, pitch: - 0.55 },
    { sdLength: L },
    { bottomZ: - 22 },
  );
  need( 'a breach profile\'s lowest station wins over the spine-tip fallback',
    Math.abs( fromProfile.along + 22 ) < 1e-9 &&
      Math.hypot( fromProfile.x - origin[ 0 ], fromProfile.z - ( origin[ 2 ] - 22 ) ) < 1e-9,
    `along ${ fromProfile.along }, xz (${ fromProfile.x.toFixed( 2 ) }, ${ fromProfile.z.toFixed( 2 ) })` );

  const dragon = new SeaDragon();
  dragon.pos[ 0 ] = origin[ 0 ];
  dragon.pos[ 2 ] = origin[ 2 ];
  dragon.heading = 0;
  dragon.pitch = - 0.55;
  dragon.jumpVy = - 14;
  dragon.throwSplash( { sdLength: L, sdSplashLand: 1 }, true );
  need( 'throwSplash opens the cavity at the nose, not the origin',
    Math.hypot( dragon.splashX - nose[ 0 ], dragon.splashZ - nose[ 1 ] ) < 1e-6,
    `splash (${ dragon.splashX.toFixed( 2 ) }, ${ dragon.splashZ.toFixed( 2 ) }) ` +
    `nose (${ nose[ 0 ].toFixed( 2 ) }, ${ nose[ 1 ].toFixed( 2 ) })` );
  dragon.pitch = 0;
  dragon.throwSplash( { sdLength: L, sdSplashExit: 1 }, false );
  need( 'an exit splash still stamps at the origin',
    Math.hypot( dragon.splashX - origin[ 0 ], dragon.splashZ - origin[ 2 ] ) < 1e-9,
    `splash (${ dragon.splashX.toFixed( 2 ) }, ${ dragon.splashZ.toFixed( 2 ) })` );
}

// ---- 7. occupancy is the silhouette, not a mid-body Gaussian --------------
{
  const L = 60;
  const rad = 7.5;
  const heading = 0;
  const dirx = Math.sin( heading ), dirz = - Math.cos( heading );
  const ox = 12, oz = - 37;
  const sea = 0;
  const rigid = {
    x: ox, y: 0, z: oz, len: L, rad, sea,
    dirx, dirz, waves: 0, sweep: 0, lift: 0, liftPhase: 0, phase: 0,
  };

  // Nose-down: origin still at the sea, nose already metres under. The
  // Gaussian centred on the origin (or even on waterContactXZ with a
  // shortened capsule) could not open a hole that is deeper at the nose
  // than amidships — occupancy must, because that station's Y is lower.
  const noseDown = { ...rigid, y: 0.05, pitch: - 0.55, sign: - 1 };
  const foreSt = spineStation( 0.4, noseDown );
  const midH = bodyOccupancy( ox, oz, noseDown );
  const foreH = bodyOccupancy( foreSt.x, foreSt.z, noseDown );
  need( 'a nose-down body still sheathes the wet forebody, not only amidships',
    foreH < - 0.5 && midH < - 0.5,
    `fore ${ foreH.toFixed( 2 ) }, amidships ${ midH.toFixed( 2 ) }` );

  const beside = bodyOccupancy( ox + rad * 2.4, oz, { ...rigid, y: - 1, pitch: 0, sign: - 1 } );
  need( 'occupancy beside the body (past 2.2 r) is empty',
    Math.abs( beside ) < 1e-9,
    `beside ${ beside.toExponential( 2 ) }` );

  const pierceH = bodyOccupancy( ox, oz, { ...rigid, y: - 1, pitch: 0, sign: - 1 } );
  const underH = bodyOccupancy( ox, oz, { ...rigid, y: - 12, pitch: 0, sign: - 1 } );
  need( 'a fully under body does not open a hollow in empty water',
    pierceH < - 0.5 && Math.abs( underH ) < 0.05,
    `y=-1 → ${ pierceH.toFixed( 2 ) }, y=-12 → ${ underH.toExponential( 2 ) }` );

  // Tail-up landing: the tail station is in the air. Its column must not
  // punch a hole in empty sky-water.
  const pitched = { ...rigid, y: 0.05, pitch: - 0.55, sign: - 1 };
  const tail = spineStation( 1, pitched );
  const hTail = bodyOccupancy( tail.x, tail.z, pitched );
  need( 'stations above the sea leave little or no hollow there',
    tail.y - tail.r > sea && Math.abs( hTail ) < 0.05,
    `tailY ${ tail.y.toFixed( 2 ) } r ${ tail.r.toFixed( 2 ) } hollow ${ hTail.toFixed( 3 ) } m` );

  // Jump-out: a nose-up body at the surface still mounds where it is wet;
  // raise the origin and those stations go airborne and release. The
  // pitched-up nose is already clear and must not lift empty water.
  const jumpWet = { ...rigid, y: 0, pitch: 0.55, sign: 1 };
  const jumpClear = { ...rigid, y: 16, pitch: 0.55, sign: 1 };
  const midWet = spineStation( 0.5, jumpWet );
  const midClear = spineStation( 0.5, jumpClear );
  const noseClear = spineStation( 0, jumpClear );
  const hMidWet = bodyOccupancy( midWet.x, midWet.z, jumpWet );
  const hMidClear = bodyOccupancy( midClear.x, midClear.z, jumpClear );
  const hNoseClear = bodyOccupancy( noseClear.x, noseClear.z, jumpClear );
  need( 'jump-out: rising stations release displacement',
    hMidWet > 0.5 && Math.abs( hMidClear ) < 0.05 && Math.abs( hNoseClear ) < 0.05,
    `wet amidships ${ hMidWet.toFixed( 2 ) } m, clear amidships ${ hMidClear.toFixed( 3 ) } m, ` +
    `airborne nose ${ hNoseClear.toFixed( 3 ) } m` );

  // Artist envelope still scales the geometric occupancy, and the sign
  // of amp (swellContactSign) still picks bulge vs hollow. They are not
  // equal-and-opposite: a body sitting below the sea has more column
  // under the water than back above it.
  const swim = bodyDisplace( ox, oz, { ...rigid, y: - 2, pitch: 0, amp: 5.78 } );
  const land = bodyDisplace( ox, oz, { ...rigid, y: - 2, pitch: 0, amp: - 5.78 } );
  need( 'bodyDisplace keeps swellContactSign: +amp mounds, −amp hollows',
    swim > 1 && land < - 1,
    `+amp ${ swim.toFixed( 2 ) } m, −amp ${ land.toFixed( 2 ) } m` );

  const deep = { ...rigid, y: - 12, pitch: 0, sign: 1 };
  const hDeep = bodyOccupancy( ox, oz, deep );
  need( 'a fully submerged body does not lift the sea (no precursor)',
    Math.abs( hDeep ) < 0.05,
    `y=-12 → ${ hDeep.toExponential( 2 ) } m` );

  need( 'occupancy unrolls a small fixed station count (7–9)',
    BODY_STATIONS >= 7 && BODY_STATIONS <= 9,
    `BODY_STATIONS = ${ BODY_STATIONS }` );
}

// ---- 8. waterline sites are local cuts, not a rail across the sea ---------
// Extruding a ring along the spine drew two parallel ridges the length of
// the screen. Displacement is now compact Gaussians on the same pierce
// sites the spray uses. Two fins must not connect; a sample far along
// that old rail must stay flat.
{
  const bins = 48;
  const minZ = - 26, maxZ = 26;
  const top = new Float32Array( bins );
  const low = new Float32Array( bins );
  const half = new Float32Array( bins );
  const step = ( maxZ - minZ ) / bins;
  for ( let b = 0; b < bins; b ++ ) {

    const z = minZ + step * ( b + 0.5 );
    const head = Math.exp( - ( ( ( z + 18 ) / 4 ) ** 2 ) ) * 7;
    const fin = Math.exp( - ( ( ( z - 10 ) / 3 ) ** 2 ) ) * 5;
    top[ b ] = Math.max( head, fin, 1.2 );
    low[ b ] = - 3;
    half[ b ] = head > fin ? 2.2 : ( fin > 1 ? 1.1 : 3.5 );

  }
  const stations = { minZ, maxZ, top, low, half };
  const origin = [ 0, - 2, 0 ];
  const placed = placeBreachEmitters( stations, {
    origin, heading: 0, pitch: 0, seaLevel: 0, count: 8,
  } );
  need( 'a two-hump mesh still reports two pierce runs',
    placed.runs.length === 2,
    `runs ${ placed.runs.length }` );
  const sites = placed.sites.map( ( s ) => ( { x: s.x, z: s.z, r: 1.2 } ) );
  need( 'those runs produce a handful of cut sites, under the shader cap',
    sites.length >= 2 && sites.length <= SWELL_SITES,
    `${ sites.length } sites` );

  const hOn = sitesOccupancy( sites[ 0 ].x, sites[ 0 ].z, sites );
  const hNeck = sitesOccupancy( 0, 0, sites );
  const hFar = sitesOccupancy( 80, 80, sites );
  let rail = 0;
  for ( let z = - 80; z <= 80; z += 4 ) {

    const h = sitesOccupancy( 0, z, sites );
    if ( h > 0.15 ) rail ++;

  }
  need( 'a cut site lifts, the neck and the far sea do not',
    hOn > 0.5 && hNeck < 0.15 && hFar < 0.05,
    `on ${ hOn.toFixed( 3 ) } neck ${ hNeck.toFixed( 3 ) } far ${ hFar.toExponential( 2 ) }` );
  need( 'a long sample along the old spine rail is not a continuous ridge',
    rail <= 6,
    `${ rail } of 41 samples along z were raised` );

  const bump = bodyDisplace( sites[ 0 ].x, sites[ 0 ].z, { sites, amp: 1.6 } );
  const empty = bodyDisplace( 80, 80, { sites, amp: 1.6 } );
  need( 'bodyDisplace with sites scales the cut and leaves empty water alone',
    bump > 0.8 && Math.abs( empty ) < 0.05,
    `cut ${ bump.toFixed( 3 ) } m, far ${ empty.toExponential( 2 ) } m` );
}

// ---- 9. a cut throws a traveling packet, never a sitting meniscus --------
{
  const field = new CutRippleField();
  const cut = [ { x: 10, z: - 4 } ];
  const opts = { width: 1.6, life: 1.2, wave: 1, speed: 8, climb: 3 };
  field.step( 0.05, cut, opts );
  const born = field.rings[ 0 ];
  const first = cutRippleHeight( 10, - 4, field );
  need( 'a new cut throws a wave at the point, not a static mound slot',
    field.rings.length >= 1 && ( born?.ring ?? 1 ) < 1.5 && first > 0.02,
    `rings ${ field.rings.length }, ringR ${ ( born?.ring ?? 0 ).toFixed( 2 ) }, h ${ first.toFixed( 3 ) }` );
  const earlyAmp = Math.abs( field.rings[ 0 ]?.amp ?? 0 );
  for ( let i = 0; i < 6; i ++ ) field.step( 0.05, cut, opts );
  const grownAmp = Math.abs( field.rings[ 0 ]?.amp ?? 0 );
  need( 'that wave grows in instead of appearing at full strength',
    RIPPLE_ATTACK > 0.1 && grownAmp > earlyAmp + 0.05,
    `amp ${ earlyAmp.toFixed( 3 ) } → ${ grownAmp.toFixed( 3 ) } over attack` );
  need( 'the shader list is only packets (no meniscus sites)',
    field.sites( 16 ).length === field.rings.filter( ( r ) => Math.abs( r.amp ) > 0.02 ).length
      && field.sites( 16 ).every( ( s ) => s.ring >= 0 ),
    `${ field.sites( 16 ).length } shader sites, ${ field.rings.length } rings` );

  field.step( 0.2, cut, opts );
  field.step( 0.2, cut, opts );
  const farEarly = Math.max( 0, ...field.rings.map( ( r ) => r.ring ) );
  need( 'that wave has left the point',
    farEarly > 2,
    `farthest ${ farEarly.toFixed( 2 ) } m, rings ${ field.rings.length }` );

  field.step( 0.05, [], opts );
  const justRing = field.rings[ 0 ]?.ring ?? 0;
  const justAround = aroundRing( field, 10, - 4, justRing );
  need( 'releasing a cut does not snap the sea to zero',
    justAround.max > 0.02 && field.rings.length >= 1,
    `just-released crest ${ justAround.max.toFixed( 3 ) }, rings ${ field.rings.length }` );

  for ( let i = 0; i < 8; i ++ ) field.step( 0.1, [], opts );
  const later = cutRippleHeight( 10, - 4, field );
  const farR = field.rings[ 0 ]?.ring ?? 0;
  const farAround = aroundRing( field, 10, - 4, farR );
  need( 'the leftover keeps running outward',
    farR > 4 && Math.abs( field.rings[ 0 ]?.amp ?? 0 ) > 0.01,
    `ringR ${ farR.toFixed( 2 ) } m, amp ${ ( field.rings[ 0 ]?.amp ?? 0 ).toFixed( 3 ) }, centre ${ later.toFixed( 3 ) }` );
  const packW = field.rings[ 0 ]?.width ?? 1.6;
  const packL = Math.max( packW * RIPPLE_LAMBDA, RIPPLE_LAMBDA_MIN );
  const trough = farR > 0.5
    ? cutRippleHeight(
      10 + Math.cos( farAround.ang ) * ( farR + packL * 0.5 ),
      - 4 + Math.sin( farAround.ang ) * ( farR + packL * 0.5 ),
      field,
    )
    : 0;
  need( 'that ring is a crest-and-trough packet, not a Gaussian stamp',
    farAround.max > 0.01 && trough < - 0.005,
    `crest ${ farAround.max.toFixed( 3 ) }, trough ${ trough.toFixed( 3 ) } at λ/2` );
  need( 'the front is slightly uneven, not a stamped compass ring',
    farAround.max - farAround.min > 0.008,
    `around-ring ${ farAround.min.toFixed( 3 ) } … ${ farAround.max.toFixed( 3 ) }` );

  for ( let i = 0; i < 24; i ++ ) field.step( 0.1, [], opts );
  const gone = cutRippleHeight( 10, - 4, field ) + cutRippleHeight( 10 + 20, - 4, field );
  need( 'after life the field is empty',
    gone < 0.05 && field.rings.length === 0,
    `leftover ${ gone.toExponential( 2 ) }, rings ${ field.rings.length }` );

  const lamFast = rippleLambda( 1.6, 16 );
  const lamSlow = rippleLambda( 1.6, 0 );
  need( 'a faster break throws a longer, quicker wave',
    lamFast > lamSlow && rippleSpeed( lamFast ) > rippleSpeed( lamSlow ),
    `λ ${ lamSlow.toFixed( 2 ) } → ${ lamFast.toFixed( 2 ) } m, ` +
    `c ${ rippleSpeed( lamSlow ).toFixed( 2 ) } → ${ rippleSpeed( lamFast ).toFixed( 2 ) } m/s` );
}

// ---- 10. a downward push inverts the packet; force scales the throw ------
{
  need( 'ripplePush: level and rise mound, a dive inverts',
    ripplePush( 0 ) === 1 && ripplePush( 3 ) === 1 && ripplePush( - 0.2 ) === 1
      && ripplePush( - 3 ) === - 1,
    `0 → ${ ripplePush( 0 ) }, +3 → ${ ripplePush( 3 ) }, ` +
    `-0.2 → ${ ripplePush( - 0.2 ) }, -3 → ${ ripplePush( - 3 ) }` );

  const softDown = rippleForce( - 1, 4, 1.6 );
  const hardDown = rippleForce( - 5, 12, 1.6 );
  const softUp = rippleForce( 1, 4, 1.6 );
  const hardUp = rippleForce( 5, 12, 1.6 );
  const rest = rippleForce( 0, 8, 1.6 );
  need( 'force scales with how hard the mesh drives the surface',
    hardDown < softDown && softDown < 0 && hardDown < - 0.7
      && hardUp > softUp && softUp > rest && rest > 0.2 && rest < 0.55,
    `down ${ softDown.toFixed( 2 ) } → ${ hardDown.toFixed( 2 ) }, ` +
    `up ${ rest.toFixed( 2 ) } / ${ softUp.toFixed( 2 ) } → ${ hardUp.toFixed( 2 ) }` );

  const rise = new CutRippleField();
  const dive = new CutRippleField();
  const gentle = new CutRippleField();
  const cut = [ { x: 4, z: 2 } ];
  const up = { width: 1.6, life: 1.2, wave: 1, speed: 8, climb: 3 };
  const down = { width: 1.6, life: 1.2, wave: 1, speed: 8, climb: - 3 };
  const soft = { width: 1.6, life: 1.2, wave: 1, speed: 4, climb: - 1 };
  for ( let i = 0; i < 8; i ++ ) {

    rise.step( 0.05, cut, up );
    dive.step( 0.05, cut, down );
    gentle.step( 0.05, cut, soft );

  }
  const riseA = rise.rings[ 0 ]?.amp0 ?? 0;
  const diveA = dive.rings[ 0 ]?.amp0 ?? 0;
  const gentleA = gentle.rings[ 0 ]?.amp0 ?? 0;
  need( 'a rise throws a positive packet and a dive inverts it',
    riseA > 0.2 && diveA < - 0.2,
    `rise amp0 ${ riseA.toFixed( 3 ) }, dive amp0 ${ diveA.toFixed( 3 ) }` );
  need( 'a harder downward push throws a stronger inverted packet',
    diveA < gentleA && gentleA < 0,
    `hard ${ diveA.toFixed( 3 ) }, gentle ${ gentleA.toFixed( 3 ) }` );

  dive.step( 0.05, [], down );
  need( 'releasing a dive does not flip the packet sign',
    dive.rings.every( ( r ) => r.amp0 < 0 ),
    `amps ${ dive.rings.map( ( r ) => r.amp0.toFixed( 2 ) ).join( ',' ) }` );

  for ( let i = 0; i < 4; i ++ ) dive.step( 0.1, [], down );
  const traveling = dive.rings.find( ( r ) => r.amp < 0 && r.ring > 0.5 );
  const ringR = traveling?.ring ?? 0;
  const hole = ringR > 0.5 ? aroundRing( dive, 4, 2, ringR ).min : 0;
  need( 'a released dive keeps an inverted ring running out',
    ringR > 2 && hole < - 0.01,
    `ringR ${ ringR.toFixed( 2 ) } m, trough ${ hole.toFixed( 3 ) }` );
}

// ---- 11. each live cut throws a ripple, stronger when the push is harder --
{
  const soft = new CutRippleField();
  const hard = new CutRippleField();
  const cut = [ { x: 0, z: 0 } ];
  const lo = { width: 1.6, life: 1.4, wave: 1, speed: 4, climb: 1.2 };
  const hi = { width: 1.6, life: 1.4, wave: 1, speed: 12, climb: 6 };
  for ( let i = 0; i < 12; i ++ ) {

    soft.step( 0.05, cut, lo );
    hard.step( 0.05, cut, hi );

  }
  const softR = soft.rings[ 0 ];
  const hardR = hard.rings[ 0 ];
  need( 'a held cut throws a traveling ripple',
    hard.rings.length >= 1 && ( hardR?.ring ?? 0 ) >= 0 && Math.abs( hardR?.amp0 ?? 0 ) > 0.05,
    `hard rings ${ hard.rings.length }, amp0 ${ ( hardR?.amp0 ?? 0 ).toFixed( 3 ) }` );
  need( 'a harder break throws a stronger ripple than a gentle one',
    Math.abs( hardR?.amp0 ?? 0 ) > Math.abs( softR?.amp0 ?? 0 ) + 0.08,
    `soft ${ ( softR?.amp0 ?? 0 ).toFixed( 3 ) } → hard ${ ( hardR?.amp0 ?? 0 ).toFixed( 3 ) }` );
}

// ---- 12. rings fade on their decay clock; they are not evicted ----------
{
  const crowded = new CutRippleField();
  const cuts = [];
  for ( let i = 0; i < 8; i ++ ) cuts.push( { x: i * 4, z: 0 } );
  const opts = { width: 1.6, life: 2.0, wave: 1, speed: 8, climb: 2, maxRings: 16 };
  for ( let i = 0; i < 30; i ++ ) crowded.step( 0.05, cuts, opts );
  const first = crowded.rings[ 0 ];
  need( 'a full waterline does not evict a ring that is still decaying',
    first && first.age < first.life && Math.abs( first.amp ) > 0.02
      && crowded.rings.length <= 16,
    `oldest age ${ ( first?.age ?? 0 ).toFixed( 2 ) } / ${ ( first?.life ?? 0 ).toFixed( 2 ) }, ` +
    `amp ${ ( first?.amp ?? 0 ).toFixed( 3 ) }, n ${ crowded.rings.length }` );

  const short = new CutRippleField();
  const long = new CutRippleField();
  const one = [ { x: 0, z: 0 } ];
  const lo = { width: 1.6, life: 1.2, wave: 1, speed: 8, climb: 3 };
  const hi = { width: 1.6, life: 4.5, wave: 1, speed: 8, climb: 3 };
  for ( let i = 0; i < 20; i ++ ) {

    short.step( 0.05, one, lo );
    long.step( 0.05, one, hi );

  }
  const sAmp = Math.abs( short.rings[ 0 ]?.amp ?? 0 );
  const lAmp = Math.abs( long.rings[ 0 ]?.amp ?? 0 );
  const sR = short.rings[ 0 ]?.ring ?? 0;
  const lR = long.rings[ 0 ]?.ring ?? 0;
  need( 'a longer decay keeps more amplitude at the same age',
    lAmp > sAmp + 0.08,
    `1.2 s → ${ sAmp.toFixed( 3 ) }, 4.5 s → ${ lAmp.toFixed( 3 ) }` );
  need( 'and the slower fade is still running farther out',
    lR > 2 && ( short.rings.length === 0 || lR >= sR - 0.5 ),
    `short ${ sR.toFixed( 2 ) } m, long ${ lR.toFixed( 2 ) } m` );

  const slow = new CutRippleField();
  const fast = new CutRippleField();
  const cut = [ { x: 0, z: 0 } ];
  const base = { width: 1.6, life: 2, wave: 1, speed: 8, climb: 3 };
  for ( let i = 0; i < 10; i ++ ) {

    slow.step( 0.05, cut, { ...base, speedMin: 4, speedMax: 6 } );
    fast.step( 0.05, cut, { ...base, speedMin: 20, speedMax: 28 } );

  }
  need( 'a higher speed floor runs the ring out faster',
    ( fast.rings[ 0 ]?.c ?? 0 ) >= 20 && ( slow.rings[ 0 ]?.c ?? 0 ) <= 6
      && ( fast.rings[ 0 ]?.ring ?? 0 ) > ( slow.rings[ 0 ]?.ring ?? 0 ) + 2,
    `c ${ ( slow.rings[ 0 ]?.c ?? 0 ).toFixed( 1 ) } → ${ ( fast.rings[ 0 ]?.c ?? 0 ).toFixed( 1 ) }, ` +
    `r ${ ( slow.rings[ 0 ]?.ring ?? 0 ).toFixed( 1 ) } → ${ ( fast.rings[ 0 ]?.ring ?? 0 ).toFixed( 1 ) }` );
}

// ---- 13. a turn cannot reshape a wave that already left -----------------
{
  const field = new CutRippleField();
  const cut = [ { x: 0, z: 0 } ];
  const throwAlongX = {
    width: 1.6, life: 4, wave: 1, speed: 8, climb: 3,
    dirX: 1, dirZ: 0, stretch: 0.12,
  };
  field.step( 0.05, cut, throwAlongX );
  for ( let i = 0; i < 10; i ++ ) field.step( 0.1, [], throwAlongX );
  const ring = field.rings[ 0 ];
  const r = ring?.ring ?? 0;
  const samples = [];
  for ( let a = 0; a < 8; a ++ ) {

    const ang = a * Math.PI / 4;
    samples.push( cutRippleHeight( Math.cos( ang ) * r, Math.sin( ang ) * r, field ) );

  }
  field.dirX = 0;
  field.dirZ = 1;
  field.stretch = 0;
  const after = [];
  for ( let a = 0; a < 8; a ++ ) {

    const ang = a * Math.PI / 4;
    after.push( cutRippleHeight( Math.cos( ang ) * r, Math.sin( ang ) * r, field ) );

  }
  const drift = samples.reduce( ( m, h, i ) => Math.max( m, Math.abs( h - after[ i ] ) ), 0 );
  need( 'turning the body does not reshape a wave that already left',
    ring && ring.dirX === 1 && ring.dirZ === 0 && Math.abs( ring.stretch - 0.12 ) < 1e-6
      && drift < 1e-9,
    `frozen dir ${ ring?.dirX },${ ring?.dirZ } stretch ${ ring?.stretch }, drift ${ drift }` );
  const alongCrest = cutRippleHeight( r * ( 1 + ( ring?.stretch ?? 0 ) ), 0, field );
  need( 'that frozen ring still stretches along the heading it was thrown on',
    Math.abs( ring?.stretch - 0.12 ) < 1e-6 && alongCrest > 0.05,
    `stretch ${ ring?.stretch }, crest-along ${ alongCrest.toFixed( 3 ) }` );
  const ahead = cutRippleHeight( r, 0, field );
  const behind = cutRippleHeight( - r, 0, field );
  const beam = cutRippleHeight( 0, r, field );
  const wide = cutRippleHeight( r * Math.cos( 2.1 ), r * Math.sin( 2.1 ), field );
  need( 'the packet is a forward arc, not a full ring',
    ahead > 0.05 && Math.abs( behind ) < Math.abs( ahead ) * 0.08
      && Math.abs( wide ) < Math.abs( ahead ) * 0.08
      && Math.abs( beam ) < Math.abs( ahead ) * 0.45,
    `ahead ${ ahead.toFixed( 3 ) } beam ${ beam.toFixed( 3 ) } behind ${ behind.toFixed( 3 ) } wide ${ wide.toFixed( 3 ) }` );
}

// ---- 14. a flank cut throws outward, and a live point can throw again --
{
  const o = outwardDir( 1, 1, 0 );
  need( 'a starboard cut throws aft-outward, not along the heading',
    o.dirX < - 0.35 && o.dirZ > 0.55,
    `outward ${ o.dirX.toFixed( 3 ) }, ${ o.dirZ.toFixed( 3 ) }` );
  const spike = outwardDir( 0, 1, 0 );
  need( 'a spike cut still throws along the heading',
    spike.dirX > 0.95 && Math.abs( spike.dirZ ) < 0.05,
    `spike ${ spike.dirX.toFixed( 3 ) }, ${ spike.dirZ.toFixed( 3 ) }` );

  const field = new CutRippleField();
  const cut = [ { x: 0, z: 0, side: 1 } ];
  const opts = {
    width: 1.6, life: 4, wave: 1, speed: 8, climb: 3,
    dirX: 1, dirZ: 0, stretch: 0,
  };
  field.step( 0.05, cut, opts );
  for ( let i = 0; i < 8; i ++ ) field.step( 0.1, cut, opts );
  const r = field.rings[ 0 ];
  const pkt = { rings: field.rings, dirX: 1, dirZ: 0, stretch: 0 };
  const out = cutRippleHeight(
    ( r?.dirX ?? 0 ) * ( r?.ring ?? 0 ),
    ( r?.dirZ ?? 1 ) * ( r?.ring ?? 0 ),
    pkt,
  );
  const along = cutRippleHeight( r?.ring ?? 0, 0, pkt );
  need( 'that flank packet is a wake arm, not a bow ring on the heading',
    r && r.dirX < - 0.3 && r.dirZ > 0.5
      && Math.abs( out ) > 0.05 && Math.abs( along ) < Math.abs( out ) * 0.35,
    `dir ${ r?.dirX },${ r?.dirZ } out ${ out.toFixed( 3 ) } along ${ along.toFixed( 3 ) }` );

  const n0 = field.rings.length;
  for ( let i = 0; i < 16; i ++ ) field.step( 0.1, cut, opts );
  need( 'a held cut throws again after its first wave has left',
    field.rings.length >= 1 && field.rings.some( ( p ) => p.ring < 8 ),
    `n ${ n0 } → ${ field.rings.length }, nearest ${ Math.min( ...field.rings.map( ( p ) => p.ring ) ).toFixed( 2 ) } m` );
}

// ---- 14b. bow and dome share one near-sea ease --------------------------
{
  const at = swellProximity( 0, 9 );
  const under = swellProximity( 2, 9 );
  const deep = swellProximity( 12, 9 );
  const out = swellProximity( - 2.0, 9 );
  const gone = swellProximity( - 2.5, 9 );
  need( 'swellProximity peaks at the waterline and fades both ways',
    at > 0.95 && under > 0.25 && under < at && deep < 0.05
      && out > 0.1 && out < at && gone < 0.02,
    `at ${ at.toFixed( 3 ) } under ${ under.toFixed( 3 ) } deep ${ deep.toFixed( 3 ) } out ${ out.toFixed( 3 ) } gone ${ gone.toFixed( 3 ) }` );
}

// ---- 15. the head pushes a bow heap; the flank leaves a wake ------------
{
  const nose = outwardDir( 1, 1, 0, { side: 1, along: - 12, kind: 'cross' } );
  need( 'a nose-half cut faces along the heading, not off the cheek',
    nose.dirX > 0.95 && Math.abs( nose.dirZ ) < 0.05,
    `nose ${ nose.dirX.toFixed( 3 ) }, ${ nose.dirZ.toFixed( 3 ) }` );

  const both = new CutRippleField();
  const cuts = [
    { x: 0, z: 0, side: 0, kind: 'spike', along: - 20, half: 3 },
    { x: 0, z: 12, side: 1, kind: 'flank', along: 8 },
  ];
  const opts = {
    width: 1.6, life: 4, wave: 1, speed: 8, climb: 3,
    dirX: 1, dirZ: 0, stretch: 0,
    fore: { x: 0, z: 0, half: 3 },
  };
  both.step( 0.05, cuts, opts );
  for ( let i = 0; i < 8; i ++ ) both.step( 0.1, cuts, opts );
  const atHead = both.rings.filter( ( p ) => Math.hypot( p.x, p.z ) < 2.5 );
  const atFlank = both.rings.filter( ( p ) => Math.hypot( p.x, p.z - 12 ) < 2.5 );
  need( 'a head site does not throw an expanding ring; the flank still does',
    atHead.length === 0 && atFlank.length >= 1,
    `head ${ atHead.length } flank ${ atFlank.length } n ${ both.rings.length }` );

  const rh = both.bow.rh;
  const peak = bowHeight( rh * 0.32, 0, both.bow );
  const atCut = bowHeight( 0, 0, both.bow );
  const behind = bowHeight( - rh, 0, both.bow );
  const cheek = bowHeight( rh * 0.32, rh * 0.7, both.bow );
  need( 'the bow heap sits on the snout and spills forward, not down the back',
    both.bow.amp > 0.15 && peak > 0.08 && atCut > peak * 0.45 && Math.abs( behind ) < peak * 0.12,
    `amp ${ both.bow.amp.toFixed( 3 ) } peak ${ peak.toFixed( 3 ) } cut ${ atCut.toFixed( 3 ) } back ${ behind.toFixed( 3 ) }` );
  need( 'and it is wide enough to part water beside the snout',
    cheek > peak * 0.15,
    `cheek ${ cheek.toFixed( 3 ) } peak ${ peak.toFixed( 3 ) }` );
  const midAft = bowHeight( - rh * 0.25, 0, both.bow );
  need( 'the aft side of the bow heap eases out; it is not a hard wall',
    midAft > peak * 0.05 && midAft < peak * 0.9,
    `mid-aft ${ midAft.toFixed( 3 ) } peak ${ peak.toFixed( 3 ) }` );
  const tallBow = { x: 0, z: 0, dirX: 1, dirZ: 0, amp: 16, rh: 4.2 };
  const shortBow = { ...tallBow, amp: 3.5 };
  const fpT = bowFootprint( tallBow.rh, tallBow.amp );
  const fpS = bowFootprint( shortBow.rh, shortBow.amp );
  const tallMid = bowHeight( 8, 0, tallBow );
  need( 'a 16 m bow is a heap, not a spike on the 4 m snout cap',
    fpT.along > fpS.along * 2 && tallMid > 8,
    `L ${ fpT.along.toFixed( 1 ) } vs ${ fpS.along.toFixed( 1 ) }  h@8m ${ tallMid.toFixed( 2 ) }` );
  const fpSoft = bowFootprint( shortBow.rh, shortBow.amp, 2 );
  const softMid = bowHeight( 8, 0, { ...shortBow, soft: 2 } );
  const tightMid = bowHeight( 8, 0, shortBow );
  need( 'bow smoothness widens the heap without changing its peak',
    Math.abs( fpSoft.along - fpS.along * 2 ) < 0.01
      && Math.abs( fpSoft.across - fpS.across * 2 ) < 0.01
      && Math.abs( bowHeight( fpS.standoff, 0, { ...shortBow, soft: 2 } )
        - bowHeight( fpS.standoff, 0, shortBow ) ) < 0.01
      && softMid > tightMid,
    `soft 2× ${ fpSoft.along.toFixed( 1 )}×${ fpSoft.across.toFixed( 1 ) } vs ${ fpS.along.toFixed( 1 )}×${ fpS.across.toFixed( 1 ) }` );
}

{
  const field = new CutRippleField();
  const nose = { x: 10, z: - 4, half: 2 };
  const headCuts = [ { x: 10, z: - 4, kind: 'spike', along: - 20, half: 2 } ];
  const backCuts = [ { x: 10, z: 22, kind: 'flank', along: 8, half: 2 } ];
  const base = {
    width: 1.6, life: 4, wave: 0, speed: 8, climb: 1,
    dirX: 0, dirZ: - 1, stretch: 0, nose,
  };
  field.step( 0.05, headCuts, { ...base, headWet: true } );
  for ( let i = 0; i < 8; i ++ ) field.step( 0.1, headCuts, { ...base, headWet: true } );
  const onNose = Math.hypot( field.bow.x - 10, field.bow.z + 4 );
  need( 'the bow heap starts on the anatomical nose',
    onNose < 0.8 && field.bow.amp > 0.15,
    `d ${ onNose.toFixed( 2 ) } amp ${ field.bow.amp.toFixed( 3 ) }` );

  for ( let i = 0; i < 16; i ++ ) {

    const moved = { x: 10, z: - 4 - i * 1.5, half: 2 };
    field.step( 0.1, backCuts, {
      ...base, nose: moved, headWet: false, fore: { x: 10, z: 22, half: 2 },
    } );

  }
  const lastNoseZ = - 4 - 15 * 1.5;
  const slid = Math.hypot( field.bow.x - 10, field.bow.z - 22 );
  const followed = Math.hypot( field.bow.x - 10, field.bow.z - lastNoseZ );
  need( 'ducking the head keeps the heap on the moving nose; it does not slide onto a back cut',
    followed < 0.05 && slid > 20 && field.bow.amp < 0.12,
    `followed ${ followed.toFixed( 2 ) } slid-to-back ${ slid.toFixed( 2 ) } amp ${ field.bow.amp.toFixed( 3 ) }` );
}

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (r.detail) console.log(`        ${r.detail}`);
}
const allOk = results.every((r) => r.ok);
console.log(`\n${allOk ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(allOk ? 0 : 1);
